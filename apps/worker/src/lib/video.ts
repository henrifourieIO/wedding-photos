import type { Context } from "hono";
import { consumeRateLimit } from "./ratelimit";
import type { EventRow } from "./events";
import type { GuestRow } from "./guest";
import { createDirectUpload, StreamError, streamConfig } from "./stream";
import {
  UPLOAD_RATE_LIMIT,
  UPLOAD_RATE_WINDOW_SECONDS,
  isVideoContentType,
  maxVideoBytes,
} from "./uploads";

export async function createVideoUpload(
  c: Context<{ Bindings: Cloudflare.Env }>,
  event: EventRow,
  me: GuestRow,
  body: Record<string, unknown>,
): Promise<Response> {
  const contentType = typeof body.content_type === "string" ? body.content_type.toLowerCase() : "";
  if (!isVideoContentType(contentType)) return c.json({ error: "unsupported_content_type" }, 415);
  const size = body.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
    return c.json({ error: "invalid_size" }, 400);
  }
  const maxBytes = maxVideoBytes(c.env);
  if (size > maxBytes) return c.json({ error: "too_large", max_bytes: maxBytes }, 413);

  const config = streamConfig(c.env);
  if (!config) return c.json({ error: "stream_not_configured" }, 503);

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
  const maxDurationSeconds = event.video_max_seconds > 0 ? event.video_max_seconds : 60;
  let upload;
  try {
    upload = await createDirectUpload(config, {
      size,
      maxDurationSeconds,
      meta: { event_id: event.id, media_id: mediaId, guest_id: me.id },
    });
  } catch (err) {
    if (err instanceof StreamError) return c.json({ error: "stream_unavailable" }, 502);
    throw err;
  }

  await c.env.DB.prepare(
    `INSERT INTO media (id, event_id, guest_id, kind, stream_uid, status, content_type, size_bytes)
     VALUES (?, ?, ?, 'video', ?, 'pending', ?, ?)`,
  )
    .bind(mediaId, event.id, me.id, upload.uid, contentType, size)
    .run();

  return c.json(
    { uploadUrl: upload.uploadUrl, mediaId, protocol: upload.protocol, maxDurationSeconds },
    201,
  );
}
