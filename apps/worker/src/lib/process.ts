import { contentTypeFormat, readImageMeta, sniffFormat } from "./image-meta";
import { renderVariants } from "./transform";
import { assertNever } from "../types";

export const THUMB_MAX_EDGE = 400;
export const WEB_MAX_EDGE = 2000;
export const MAX_DECODE_PIXELS = 16_000_000;
export const MAX_ATTEMPTS = 3;

type MediaRow = {
  id: string;
  event_id: string;
  kind: string;
  status: string;
  r2_key: string | null;
  content_type: string | null;
};

export type ProcessOutcome = "ready" | "rejected" | "skipped";

export class RejectError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export function derivativeKey(eventId: string, mediaId: string, variant: "thumb" | "web"): string {
  return `events/${eventId}/${variant}/${mediaId}.jpg`;
}

async function reject(env: Cloudflare.Env, id: string, reason: string): Promise<ProcessOutcome> {
  await env.DB.prepare(
    `UPDATE media SET status = 'rejected', reason = ?, error = NULL, processed_at = datetime('now')
     WHERE id = ? AND status = 'processing'`,
  )
    .bind(reason, id)
    .run();
  return "rejected";
}

export async function processPhoto(env: Cloudflare.Env, mediaId: string): Promise<ProcessOutcome> {
  const row = await env.DB.prepare(
    "SELECT id, event_id, kind, status, r2_key, content_type FROM media WHERE id = ?",
  )
    .bind(mediaId)
    .first<MediaRow>();
  if (!row || row.kind !== "photo") return "skipped";
  switch (row.status) {
    case "ready":
    case "rejected":
    case "failed":
      return "skipped";
    case "pending":
      throw new Error("media not uploaded yet");
    default:
      break;
  }

  const claim = await env.DB.prepare(
    "UPDATE media SET status = 'processing' WHERE id = ? AND status IN ('uploaded', 'processing')",
  )
    .bind(mediaId)
    .run();
  if (claim.meta.changes === 0) return "skipped";

  if (!row.r2_key) return reject(env, row.id, "missing_original");
  const object = await env.PHOTOS.get(row.r2_key);
  if (!object) throw new Error("original missing from R2");
  const bytes = new Uint8Array(await object.arrayBuffer());

  const sniffed = sniffFormat(bytes);
  if (!sniffed) return reject(env, row.id, "unrecognized_image");
  const declared = contentTypeFormat(row.content_type ?? "");
  if (sniffed !== declared) return reject(env, row.id, "content_type_mismatch");

  const meta = readImageMeta(bytes, sniffed);
  const swapped = meta.orientation >= 5;
  const width = swapped ? meta.height : meta.width;
  const height = swapped ? meta.width : meta.height;

  let reason: string | null = null;
  let thumbKey: string | null = null;
  let webKey: string | null = null;

  switch (sniffed) {
    case "heic":
      reason = "no_derivative_heic";
      break;
    case "jpeg":
    case "png":
    case "webp": {
      if (meta.width === null || meta.height === null || meta.width < 1 || meta.height < 1) {
        return reject(env, row.id, "invalid_dimensions");
      }
      if (meta.width * meta.height > MAX_DECODE_PIXELS) {
        reason = "no_derivative_oversize";
        break;
      }
      let variants;
      try {
        variants = renderVariants(bytes, meta.orientation, [THUMB_MAX_EDGE, WEB_MAX_EDGE]);
      } catch {
        return reject(env, row.id, "decode_failed");
      }
      const [thumb, web] = variants;
      if (!thumb || !web) throw new Error("variant render failed");
      thumbKey = derivativeKey(row.event_id, row.id, "thumb");
      webKey = derivativeKey(row.event_id, row.id, "web");
      const httpMetadata = { contentType: "image/jpeg" };
      await Promise.all([
        env.PHOTOS.put(thumbKey, thumb.bytes, { httpMetadata }),
        env.PHOTOS.put(webKey, web.bytes, { httpMetadata }),
      ]);
      break;
    }
    default:
      return assertNever(sniffed);
  }

  await env.DB.prepare(
    `UPDATE media SET status = 'ready', width = ?, height = ?, taken_at = ?, reason = ?, error = NULL,
       thumb_key = ?, web_key = ?, processed_at = datetime('now')
     WHERE id = ? AND status = 'processing'`,
  )
    .bind(width, height, meta.takenAt, reason, thumbKey, webKey, row.id)
    .run();
  return "ready";
}

export async function markFailed(
  env: Cloudflare.Env,
  mediaId: string,
  error: unknown,
): Promise<void> {
  const text = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  await env.DB.prepare(
    `UPDATE media SET status = 'failed', error = ?, processed_at = datetime('now')
     WHERE id = ? AND status IN ('uploaded', 'processing')`,
  )
    .bind(text, mediaId)
    .run();
}
