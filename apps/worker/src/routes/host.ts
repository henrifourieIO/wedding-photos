import { Hono } from "hono";
import QRCode from "qrcode";
import type { AppEnv, EventRow, HostEventDto, RevealMode } from "../types";
import {
  generateEventId,
  generateJoinCode,
  guestUrlFromRequest,
  parseRevealMode,
  rowToHostEvent,
  validateRevealAt,
} from "../lib/hostEvents";
import { coverObjectKey, extensionFromContentType, presignCoverPut } from "../lib/cover";

type CreateEventBody = {
  name?: unknown;
  startsAt?: unknown;
  revealMode?: unknown;
  revealAt?: unknown;
  videoMaxSeconds?: unknown;
  coverContentType?: unknown;
};

type UpdateEventBody = CreateEventBody;

function parseVideoMaxSeconds(value: unknown): number {
  if (value === undefined || value === null) {
    return 60;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("invalid_video_max_seconds");
  }
  const rounded = Math.round(value);
  if (rounded < 5 || rounded > 300) {
    throw new Error("invalid_video_max_seconds");
  }
  return rounded;
}

function parseName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("invalid_name");
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 120) {
    throw new Error("invalid_name");
  }
  return trimmed;
}

function parseStartsAt(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("invalid_starts_at");
  }
  return value;
}

async function fetchEventById(
  db: D1Database,
  id: string,
  hostSub: string,
): Promise<EventRow | null> {
  const row = await db
    .prepare(
      `SELECT id, host_sub, name, starts_at, cover_key, join_code, reveal_mode, reveal_at, video_max_seconds, created_at
       FROM events WHERE id = ? AND host_sub = ?`,
    )
    .bind(id, hostSub)
    .first<EventRow>();
  return row;
}

async function maybeCoverUpload(
  c: { env: Cloudflare.Env; req: { url: string } },
  eventId: string,
  coverContentType: unknown,
): Promise<HostEventDto["coverUpload"] | undefined> {
  if (coverContentType === undefined || coverContentType === null || coverContentType === "") {
    return undefined;
  }
  if (typeof coverContentType !== "string") {
    throw new Error("invalid_cover_content_type");
  }
  const ext = extensionFromContentType(coverContentType);
  const key = coverObjectKey(eventId, ext);
  const uploadUrl = await presignCoverPut(c.env, key, coverContentType);
  if (!uploadUrl) {
    throw new Error("cover_presign_unavailable");
  }
  return { key, uploadUrl };
}

export const host = new Hono<AppEnv>();

host.get("/events", async (c) => {
  const hostSub = c.get("hostSub");
  const { results } = await c.env.DB.prepare(
    `SELECT id, host_sub, name, starts_at, cover_key, join_code, reveal_mode, reveal_at, video_max_seconds, created_at
     FROM events WHERE host_sub = ? ORDER BY created_at DESC`,
  )
    .bind(hostSub)
    .all<EventRow>();

  const events = results.map((row) =>
    rowToHostEvent(row, guestUrlFromRequest(c.req.url, row.join_code)),
  );
  return c.json({ events });
});

host.post("/events", async (c) => {
  let body: CreateEventBody;
  try {
    body = await c.req.json<CreateEventBody>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  try {
    const hostSub = c.get("hostSub");
    const name = parseName(body.name);
    const startsAt = parseStartsAt(body.startsAt);
    const revealMode = parseRevealMode(body.revealMode) ?? "instant";
    const revealAt = validateRevealAt(revealMode, body.revealAt);
    if (revealMode === "delayed" && !revealAt) {
      throw new Error("invalid_reveal_at");
    }
    const videoMaxSeconds = parseVideoMaxSeconds(body.videoMaxSeconds);
    const id = generateEventId();
    const joinCode = generateJoinCode();

    let coverKey: string | null = null;
    let coverUpload: HostEventDto["coverUpload"];
    if (body.coverContentType && typeof body.coverContentType === "string") {
      const ext = extensionFromContentType(body.coverContentType);
      coverKey = coverObjectKey(id, ext);
      coverUpload = await maybeCoverUpload(c, id, body.coverContentType);
    }

    await c.env.DB.prepare(
      `INSERT INTO events (id, host_sub, name, starts_at, cover_key, join_code, reveal_mode, reveal_at, video_max_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, hostSub, name, startsAt, coverKey, joinCode, revealMode, revealAt, videoMaxSeconds)
      .run();

    await c.env.LINKS.put(joinCode, id);

    const row = await fetchEventById(c.env.DB, id, hostSub);
    if (!row) {
      return c.json({ error: "create_failed" }, 500);
    }

    const event = rowToHostEvent(row, guestUrlFromRequest(c.req.url, joinCode));
    if (coverUpload) {
      event.coverUpload = coverUpload;
    }
    return c.json({ event }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_request";
    return c.json({ error: message }, 400);
  }
});

host.patch("/events/:id", async (c) => {
  const id = c.req.param("id");
  const hostSub = c.get("hostSub");
  const existing = await fetchEventById(c.env.DB, id, hostSub);
  if (!existing) {
    return c.json({ error: "not_found" }, 404);
  }

  let body: UpdateEventBody;
  try {
    body = await c.req.json<UpdateEventBody>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  try {
    let name = existing.name;
    let startsAt: string | null = existing.starts_at;
    let revealMode: RevealMode = existing.reveal_mode;
    let revealAt: string | null = existing.reveal_at;
    let videoMaxSeconds = existing.video_max_seconds;
    let coverKey = existing.cover_key;

    if (body.name !== undefined) {
      name = parseName(body.name);
    }
    if (body.startsAt !== undefined) {
      startsAt = parseStartsAt(body.startsAt);
    }
    if (body.revealMode !== undefined) {
      const parsed = parseRevealMode(body.revealMode);
      if (!parsed) {
        throw new Error("invalid_reveal_mode");
      }
      revealMode = parsed;
    }
    if (body.revealAt !== undefined) {
      revealAt = validateRevealAt(revealMode, body.revealAt);
    } else if (revealMode !== "delayed") {
      revealAt = null;
    }
    if (body.videoMaxSeconds !== undefined) {
      videoMaxSeconds = parseVideoMaxSeconds(body.videoMaxSeconds);
    }

    let coverUpload: HostEventDto["coverUpload"];
    if (body.coverContentType && typeof body.coverContentType === "string") {
      const ext = extensionFromContentType(body.coverContentType);
      coverKey = coverObjectKey(id, ext);
      coverUpload = await maybeCoverUpload(c, id, body.coverContentType);
    }

    await c.env.DB.prepare(
      `UPDATE events SET name = ?, starts_at = ?, cover_key = ?, reveal_mode = ?, reveal_at = ?, video_max_seconds = ?
       WHERE id = ? AND host_sub = ?`,
    )
      .bind(name, startsAt, coverKey, revealMode, revealAt, videoMaxSeconds, id, hostSub)
      .run();

    const row = await fetchEventById(c.env.DB, id, hostSub);
    if (!row) {
      return c.json({ error: "update_failed" }, 500);
    }

    const event = rowToHostEvent(row, guestUrlFromRequest(c.req.url, row.join_code));
    if (coverUpload) {
      event.coverUpload = coverUpload;
    }
    return c.json({ event });
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_request";
    return c.json({ error: message }, 400);
  }
});

host.get("/events/:id/qr", async (c) => {
  const id = c.req.param("id");
  const hostSub = c.get("hostSub");
  const row = await fetchEventById(c.env.DB, id, hostSub);
  if (!row) {
    return c.json({ error: "not_found" }, 404);
  }

  const url = guestUrlFromRequest(c.req.url, row.join_code);
  const svg = await QRCode.toString(url, { type: "svg", margin: 2 });
  return c.body(svg, 200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "no-store",
  });
});
