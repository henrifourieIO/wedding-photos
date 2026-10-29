import { assertNever } from "../types";

export const PHOTO_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heic",
  "image/webp": "webp",
} as const;

export type PhotoContentType = keyof typeof PHOTO_TYPES;
export type UploadKind = "photo" | "video";

export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const UPLOAD_RATE_LIMIT = 60;
export const UPLOAD_RATE_WINDOW_SECONDS = 600;

export function isPhotoContentType(value: string): value is PhotoContentType {
  return Object.prototype.hasOwnProperty.call(PHOTO_TYPES, value);
}

export function parseKind(value: unknown): UploadKind | null {
  if (value === undefined || value === "photo") return "photo";
  if (value === "video") return "video";
  return null;
}

export function describeKind(kind: UploadKind): "photo" | "video" {
  switch (kind) {
    case "photo":
    case "video":
      return kind;
    default:
      return assertNever(kind);
  }
}

export function maxUploadBytes(env: Cloudflare.Env): number {
  const parsed = Number.parseInt(env.MAX_UPLOAD_BYTES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_UPLOAD_BYTES;
}

export function originalKey(
  eventId: string,
  mediaId: string,
  contentType: PhotoContentType,
): string {
  return `events/${eventId}/orig/${mediaId}.${PHOTO_TYPES[contentType]}`;
}
