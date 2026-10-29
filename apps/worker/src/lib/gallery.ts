import { isGalleryVisible, type EventRow } from "./events";

export type GalleryMediaRow = {
  id: string;
  kind: string;
  status: string;
  hidden: number;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  taken_at: string | null;
  created_at: string;
  poster_url: string | null;
  hls_url: string | null;
  guest_id: string | null;
  display_name: string | null;
};

export type GalleryItemDto = {
  id: string;
  kind: "photo" | "video";
  width: number | null;
  height: number | null;
  duration_s: number | null;
  taken_at: string | null;
  created_at: string;
  thumb_url: string | null;
  web_url: string | null;
  poster_url: string | null;
  hls_url: string | null;
};

export type HostMediaItemDto = GalleryItemDto & {
  status: string;
  hidden: boolean;
  guest_id: string | null;
  display_name: string | null;
};

export const GALLERY_PAGE_DEFAULT = 50;
export const GALLERY_PAGE_MAX = 100;

export const ZIP_MAX_FILES = 200;
export const ZIP_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export function parsePageSize(raw: string | undefined): number {
  if (!raw) return GALLERY_PAGE_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) return GALLERY_PAGE_DEFAULT;
  return Math.min(n, GALLERY_PAGE_MAX);
}

export type GalleryCursor = { created_at: string; id: string };

export function encodeCursor(cursor: GalleryCursor): string {
  return btoa(JSON.stringify(cursor));
}

export function decodeCursor(raw: string | undefined): GalleryCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(atob(raw)) as GalleryCursor;
    if (typeof parsed.created_at !== "string" || typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isReadyForGallery(row: Pick<GalleryMediaRow, "status" | "hidden">): boolean {
  return row.status === "ready" && row.hidden === 0;
}

export function guestGalleryOpen(event: EventRow, now = new Date()): boolean {
  return isGalleryVisible(event, now);
}

function photoUrls(code: string, id: string): { thumb_url: string; web_url: string } {
  const base = `/api/events/${encodeURIComponent(code)}/media/${encodeURIComponent(id)}`;
  return { thumb_url: `${base}/thumb`, web_url: `${base}/web` };
}

export function toGalleryItem(row: GalleryMediaRow, code: string): GalleryItemDto {
  const kind = row.kind === "video" ? "video" : "photo";
  const urls =
    kind === "photo" ? photoUrls(code, row.id) : { thumb_url: null, web_url: null as string | null };
  return {
    id: row.id,
    kind,
    width: row.width,
    height: row.height,
    duration_s: row.duration_s,
    taken_at: row.taken_at,
    created_at: row.created_at,
    thumb_url: urls.thumb_url,
    web_url: urls.web_url,
    poster_url: row.poster_url,
    hls_url: row.hls_url,
  };
}

export function toHostMediaItem(row: GalleryMediaRow, code: string): HostMediaItemDto {
  return {
    ...toGalleryItem(row, code),
    status: row.status,
    hidden: row.hidden !== 0,
    guest_id: row.guest_id,
    display_name: row.display_name,
  };
}

export const GALLERY_SELECT = `m.id, m.kind, m.status, m.hidden, m.width, m.height, m.duration_s, m.taken_at, m.created_at,
  m.poster_url, m.hls_url, m.guest_id, g.display_name`;

export const GALLERY_FROM = `FROM media m LEFT JOIN guests g ON g.id = m.guest_id`;
