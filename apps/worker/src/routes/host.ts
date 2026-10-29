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
import {
  GALLERY_FROM,
  GALLERY_SELECT,
  toHostMediaItem,
  type GalleryMediaRow,
} from "../lib/gallery";
import { announceMedia, buildEnvelope, connectRoom, notifyRoom } from "../lib/room";
import { deleteMediaObjects } from "../lib/mediaStorage";
import { buildEventZip } from "../lib/zipExport";

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

host.get("/events/:id/media", async (c) => {
  const id = c.req.param("id");
  const hostSub = c.get("hostSub");
  const row = await fetchEventById(c.env.DB, id, hostSub);
  if (!row) return c.json({ error: "not_found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT ${GALLERY_SELECT} ${GALLERY_FROM} WHERE m.event_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 2000`,
  )
    .bind(id)
    .all<GalleryMediaRow>();

  return c.json({
    media: results.map((m) => toHostMediaItem(m, row.join_code)),
  });
});

host.patch("/events/:id/media/:mediaId", async (c) => {
  const eventId = c.req.param("id");
  const mediaId = c.req.param("mediaId");
  const hostSub = c.get("hostSub");
  const event = await fetchEventById(c.env.DB, eventId, hostSub);
  if (!event) return c.json({ error: "not_found" }, 404);

  let body: { hidden?: unknown };
  try {
    body = await c.req.json<{ hidden?: unknown }>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (typeof body.hidden !== "boolean") return c.json({ error: "invalid_hidden" }, 400);

  const result = await c.env.DB.prepare("UPDATE media SET hidden = ? WHERE id = ? AND event_id = ?")
    .bind(body.hidden ? 1 : 0, mediaId, eventId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  if (body.hidden) {
    await notifyRoom(c.env, eventId, buildEnvelope({ type: "media.hidden", id: mediaId }, true));
  } else {
    await announceMedia(c.env, mediaId);
  }
  return c.json({ id: mediaId, hidden: body.hidden });
});

host.delete("/events/:id/media/:mediaId", async (c) => {
  const eventId = c.req.param("id");
  const mediaId = c.req.param("mediaId");
  const hostSub = c.get("hostSub");
  const event = await fetchEventById(c.env.DB, eventId, hostSub);
  if (!event) return c.json({ error: "not_found" }, 404);

  const media = await c.env.DB.prepare(
    "SELECT kind, r2_key, thumb_key, web_key, stream_uid FROM media WHERE id = ? AND event_id = ?",
  )
    .bind(mediaId, eventId)
    .first<{
      kind: string;
      r2_key: string | null;
      thumb_key: string | null;
      web_key: string | null;
      stream_uid: string | null;
    }>();
  if (!media) return c.json({ error: "not_found" }, 404);

  await deleteMediaObjects(c.env, c.env.PHOTOS, media);
  await c.env.DB.prepare("DELETE FROM media WHERE id = ? AND event_id = ?")
    .bind(mediaId, eventId)
    .run();
  await notifyRoom(c.env, eventId, buildEnvelope({ type: "media.deleted", id: mediaId }, true));
  return c.body(null, 204);
});

host.get("/events/:id/live", async (c) => {
  const eventId = c.req.param("id");
  const event = await fetchEventById(c.env.DB, eventId, c.get("hostSub"));
  if (!event) return c.json({ error: "not_found" }, 404);
  return connectRoom(c.env, eventId, "host", c.req.raw);
});

host.get("/events/:id/zip", async (c) => {
  const eventId = c.req.param("id");
  const hostSub = c.get("hostSub");
  const event = await fetchEventById(c.env.DB, eventId, hostSub);
  if (!event) return c.json({ error: "not_found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, created_at, r2_key, web_key, stream_uid FROM media
     WHERE event_id = ? AND status = 'ready' AND hidden = 0
     ORDER BY created_at ASC, id ASC`,
  )
    .bind(eventId)
    .all<{
      id: string;
      kind: string;
      created_at: string;
      r2_key: string | null;
      web_key: string | null;
      stream_uid: string | null;
    }>();

  const built = await buildEventZip(c.env, c.env.PHOTOS, event.name, results);
  if (!built.ok) {
    const status = built.status as 404 | 413;
    return c.json(
      { error: built.error, ...(built.limit !== undefined ? { limit: built.limit } : {}) },
      status,
    );
  }
  return built.response;
});
