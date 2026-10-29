import { Hono } from "hono";
import type { Context } from "hono";
import { consumeRateLimit } from "../lib/ratelimit";
import {
  decodeCursor,
  encodeCursor,
  GALLERY_FROM,
  GALLERY_SELECT,
  guestGalleryOpen,
  isReadyForGallery,
  parsePageSize,
  toGalleryItem,
  type GalleryMediaRow,
} from "../lib/gallery";
import { isGalleryVisible, resolveEvent, type EventRow } from "../lib/events";
import {
  authenticateGuest,
  GuestCookieSecretMissingError,
  GUEST_COOKIE_SECRET_SETUP_HINT,
  issueGuest,
  normalizeDisplayName,
  type GuestRow,
} from "../lib/guest";
import { presignR2Put, type R2PresignConfig } from "../lib/r2";
import {
  UPLOAD_RATE_LIMIT,
  UPLOAD_RATE_WINDOW_SECONDS,
  describeKind,
  isPhotoContentType,
  maxUploadBytes,
  originalKey,
  parseKind,
} from "../lib/uploads";
import { createVideoUpload } from "../lib/video";
import type { PhotoQueueMessage } from "../types";

type GuestEnv = { Bindings: Cloudflare.Env };
type Ctx = Context<GuestEnv>;

type MediaRow = {
  id: string;
  guest_id: string | null;
  status: string;
  r2_key: string | null;
  content_type: string | null;
  size_bytes: number | null;
};

const NOT_FOUND = { error: "not_found" } as const;
const UNAUTHORIZED = { error: "unauthorized" } as const;
const GUEST_CREATE_LIMIT = 20;

export const guest = new Hono<GuestEnv>();

function presignConfig(env: Cloudflare.Env): R2PresignConfig | null {
  if (
    !env.R2_ACCOUNT_ID ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY ||
    !env.R2_BUCKET_NAME
  ) {
    return null;
  }
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET_NAME,
  };
}

async function loadEvent(c: Ctx): Promise<EventRow | null> {
  return resolveEvent(c.env, c.req.param("code") ?? "");
}

async function loadEventAndGuest(
  c: Ctx,
): Promise<{ event: EventRow; guest: GuestRow } | { error: Response }> {
  const event = await loadEvent(c);
  if (!event) return { error: c.json(NOT_FOUND, 404) };
  const me = await authenticateGuest(c, event.join_code, event.id);
  if (!me) return { error: c.json(UNAUTHORIZED, 401) };
  return { event, guest: me };
}

async function readJson(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

guest.get("/events/:code", async (c) => {
  const event = await loadEvent(c);
  if (!event) return c.json(NOT_FOUND, 404);
  return c.json({
    name: event.name,
    cover_url: event.cover_key ? `/api/events/${event.join_code}/cover` : null,
    reveal_mode: event.reveal_mode,
    gallery_visible: isGalleryVisible(event),
    video_max_seconds: event.video_max_seconds,
  });
});

guest.get("/events/:code/cover", async (c) => {
  const event = await loadEvent(c);
  if (!event?.cover_key) return c.json(NOT_FOUND, 404);
  const object = await c.env.PHOTOS.get(event.cover_key);
  if (!object) return c.json(NOT_FOUND, 404);
  const headers = new Headers({ "cache-control": "public, max-age=3600" });
  object.writeHttpMetadata(headers);
  return new Response(object.body, { headers });
});

guest.post("/events/:code/guests", async (c) => {
  const event = await loadEvent(c);
  if (!event) return c.json(NOT_FOUND, 404);
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const limit = await consumeRateLimit(c.env.LINKS, `guest:${ip}`, GUEST_CREATE_LIMIT, 600);
  if (!limit.allowed) return c.json({ error: "rate_limited" }, 429);
  const body = await readJson(c);
  const displayName = normalizeDisplayName(body.display_name);
  if (!displayName) return c.json({ error: "invalid_display_name" }, 400);
  try {
    const created = await issueGuest(c, event.join_code, event.id, displayName);
    return c.json({ id: created.id, display_name: created.display_name }, 201);
  } catch (error) {
    if (error instanceof GuestCookieSecretMissingError) {
      return c.json(
        { error: "guest_cookie_secret_not_configured", hint: GUEST_COOKIE_SECRET_SETUP_HINT },
        503,
      );
    }
    throw error;
  }
});

guest.get("/events/:code/me", async (c) => {
  const auth = await loadEventAndGuest(c);
  if ("error" in auth) return auth.error;
  return c.json({ id: auth.guest.id, display_name: auth.guest.display_name });
});

guest.post("/events/:code/uploads", async (c) => {
  const auth = await loadEventAndGuest(c);
  if ("error" in auth) return auth.error;
  const { event, guest: me } = auth;

  const body = await readJson(c);
  const kind = parseKind(body.kind);
  if (!kind) return c.json({ error: "invalid_kind" }, 400);
  switch (describeKind(kind)) {
    case "video":
      return createVideoUpload(c, event, me, body);
    case "photo":
      break;
  }

  const contentType = typeof body.content_type === "string" ? body.content_type.toLowerCase() : "";
  if (!isPhotoContentType(contentType)) return c.json({ error: "unsupported_content_type" }, 415);
  const size = body.size;
  const maxBytes = maxUploadBytes(c.env);
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
    return c.json({ error: "invalid_size" }, 400);
  }
  if (size > maxBytes) return c.json({ error: "too_large", max_bytes: maxBytes }, 413);

  const limit = await consumeRateLimit(
    c.env.LINKS,
    `upload:${me.id}`,
    UPLOAD_RATE_LIMIT,
    UPLOAD_RATE_WINDOW_SECONDS,
  );
  if (!limit.allowed) {
    return c.json({ error: "rate_limited" }, 429, {
      "retry-after": String(UPLOAD_RATE_WINDOW_SECONDS),
    });
  }

  const mediaId = crypto.randomUUID();
  const key = originalKey(event.id, mediaId, contentType);
  await c.env.DB.prepare(
    `INSERT INTO media (id, event_id, guest_id, kind, r2_key, status, content_type, size_bytes)
     VALUES (?, ?, ?, 'photo', ?, 'pending', ?, ?)`,
  )
    .bind(mediaId, event.id, me.id, key, contentType, size)
    .run();

  const presign = presignConfig(c.env);
  if (presign) {
    const url = await presignR2Put(presign, key, contentType);
    return c.json(
      {
        id: mediaId,
        mode: "presigned",
        upload: { method: "PUT", url, headers: { "content-type": contentType } },
      },
      201,
    );
  }
  return c.json(
    {
      id: mediaId,
      mode: "proxy",
      upload: {
        method: "PUT",
        url: `/api/events/${event.join_code}/uploads/${mediaId}/body`,
        headers: { "content-type": contentType },
      },
    },
    201,
  );
});

async function loadOwnMedia(c: Ctx, eventId: string, guestId: string): Promise<MediaRow | null> {
  const id = c.req.param("id") ?? "";
  return c.env.DB.prepare(
    `SELECT id, guest_id, status, r2_key, content_type, size_bytes FROM media
     WHERE id = ? AND event_id = ? AND guest_id = ? AND kind = 'photo'`,
  )
    .bind(id, eventId, guestId)
    .first<MediaRow>();
}

guest.put("/events/:code/uploads/:id/body", async (c) => {
  if (presignConfig(c.env)) return c.json(NOT_FOUND, 404);
  const auth = await loadEventAndGuest(c);
  if ("error" in auth) return auth.error;
  const media = await loadOwnMedia(c, auth.event.id, auth.guest.id);
  if (!media?.r2_key || media.status !== "pending") return c.json(NOT_FOUND, 404);

  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (contentType !== media.content_type) return c.json({ error: "content_type_mismatch" }, 415);
  const length = Number.parseInt(c.req.header("content-length") ?? "", 10);
  if (!Number.isInteger(length) || length <= 0) return c.json({ error: "length_required" }, 411);
  if (length > maxUploadBytes(c.env)) return c.json({ error: "too_large" }, 413);
  if (!c.req.raw.body) return c.json({ error: "empty_body" }, 400);

  const { readable, writable } = new FixedLengthStream(length);
  const piping = c.req.raw.body.pipeTo(writable);
  await Promise.all([
    c.env.PHOTOS.put(media.r2_key, readable, { httpMetadata: { contentType } }),
    piping,
  ]);
  return c.body(null, 204);
});

guest.post("/events/:code/uploads/:id/complete", async (c) => {
  const auth = await loadEventAndGuest(c);
  if ("error" in auth) return auth.error;
  const media = await loadOwnMedia(c, auth.event.id, auth.guest.id);
  if (!media?.r2_key) return c.json(NOT_FOUND, 404);
  if (media.status !== "pending") return c.json({ id: media.id, status: media.status });

  const head = await c.env.PHOTOS.head(media.r2_key);
  if (!head) return c.json({ error: "object_missing" }, 409);
  if (head.size > maxUploadBytes(c.env)) {
    await c.env.PHOTOS.delete(media.r2_key);
    await c.env.DB.prepare("UPDATE media SET status = 'rejected' WHERE id = ?")
      .bind(media.id)
      .run();
    return c.json({ error: "too_large" }, 413);
  }

  const result = await c.env.DB.prepare(
    "UPDATE media SET status = 'uploaded', size_bytes = ? WHERE id = ? AND status = 'pending'",
  )
    .bind(head.size, media.id)
    .run();
  if (result.meta.changes > 0) {
    const message: PhotoQueueMessage = { mediaId: media.id, eventId: auth.event.id };
    await c.env.PHOTO_QUEUE.send(message);
  }
  return c.json({ id: media.id, status: "uploaded", size: head.size });
});

guest.get("/events/:code/gallery", async (c) => {
  const event = await loadEvent(c);
  if (!event) return c.json(NOT_FOUND, 404);

  const visible = guestGalleryOpen(event);
  const pageSize = parsePageSize(c.req.query("page_size"));
  const cursor = decodeCursor(c.req.query("cursor"));

  if (!visible) {
    return c.json({
      gallery_visible: false,
      reveal_mode: event.reveal_mode,
      reveal_at: event.reveal_at,
      items: [],
      next_cursor: null,
    });
  }

  const sql = cursor
    ? `SELECT ${GALLERY_SELECT} ${GALLERY_FROM}
       WHERE m.event_id = ? AND m.status = 'ready' AND m.hidden = 0
         AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))
       ORDER BY m.created_at DESC, m.id DESC LIMIT ?`
    : `SELECT ${GALLERY_SELECT} ${GALLERY_FROM}
       WHERE m.event_id = ? AND m.status = 'ready' AND m.hidden = 0
       ORDER BY m.created_at DESC, m.id DESC LIMIT ?`;

  const stmt = c.env.DB.prepare(sql);
  const bound = cursor
    ? stmt.bind(event.id, cursor.created_at, cursor.created_at, cursor.id, pageSize + 1)
    : stmt.bind(event.id, pageSize + 1);

  const { results } = await bound.all<GalleryMediaRow>();
  const slice = results.slice(0, pageSize);
  const next =
    results.length > pageSize
      ? encodeCursor({
          created_at: slice[slice.length - 1]?.created_at ?? "",
          id: slice[slice.length - 1]?.id ?? "",
        })
      : null;

  return c.json({
    gallery_visible: true,
    reveal_mode: event.reveal_mode,
    reveal_at: event.reveal_at,
    items: slice.filter(isReadyForGallery).map((row) => toGalleryItem(row, event.join_code)),
    next_cursor: next,
  });
});

guest.get("/events/:code/me/media", async (c) => {
  const auth = await loadEventAndGuest(c);
  if ("error" in auth) return auth.error;
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, status, content_type, size_bytes, created_at, duration_s, poster_url, hls_url FROM media
     WHERE event_id = ? AND guest_id = ? ORDER BY created_at DESC, id LIMIT 500`,
  )
    .bind(auth.event.id, auth.guest.id)
    .all<{
      id: string;
      kind: string;
      status: string;
      content_type: string | null;
      size_bytes: number | null;
      created_at: string;
      duration_s: number | null;
      poster_url: string | null;
      hls_url: string | null;
    }>();
  return c.json({ media: results });
});
