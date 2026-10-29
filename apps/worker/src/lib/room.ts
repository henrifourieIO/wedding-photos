import { isGalleryVisible, type EventRow } from "./events";
import { toGalleryItem, type GalleryItemDto, type GalleryMediaRow } from "./gallery";
import { assertNever } from "../types";

export type RoomMessage =
  | { type: "media.ready"; item: GalleryItemDto }
  | { type: "media.failed"; id: string }
  | { type: "media.hidden"; id: string }
  | { type: "media.deleted"; id: string };

export type RoomAudience = "all" | "host";

export type RoomEnvelope = { audience: RoomAudience; message: RoomMessage };

export function audienceFor(message: RoomMessage, revealed: boolean): RoomAudience {
  switch (message.type) {
    case "media.ready":
      return revealed ? "all" : "host";
    case "media.failed":
      return "host";
    case "media.hidden":
    case "media.deleted":
      return "all";
    default:
      return assertNever(message);
  }
}

export function buildEnvelope(message: RoomMessage, revealed: boolean): RoomEnvelope {
  return { audience: audienceFor(message, revealed), message };
}

export function serializeMessage(message: RoomMessage): string {
  return JSON.stringify(message);
}

export function parseEnvelope(raw: unknown): RoomEnvelope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { audience, message } = raw as { audience?: unknown; message?: unknown };
  if (audience !== "all" && audience !== "host") return null;
  if (typeof message !== "object" || message === null) return null;
  const m = message as { type?: unknown; id?: unknown; item?: unknown };
  switch (m.type) {
    case "media.ready":
      return typeof m.item === "object" && m.item !== null
        ? { audience, message: { type: m.type, item: m.item as GalleryItemDto } }
        : null;
    case "media.failed":
    case "media.hidden":
    case "media.deleted":
      return typeof m.id === "string" ? { audience, message: { type: m.type, id: m.id } } : null;
    default:
      return null;
  }
}

export async function notifyRoom(
  env: Cloudflare.Env,
  eventId: string,
  envelope: RoomEnvelope,
): Promise<void> {
  try {
    const stub = env.EVENT_ROOM.get(env.EVENT_ROOM.idFromName(eventId));
    await stub.fetch("https://room/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
  } catch (error) {
    console.error("room notify failed", error);
  }
}

export function connectRoom(
  env: Cloudflare.Env,
  eventId: string,
  audience: "guest" | "host",
  request: Request,
): Promise<Response> {
  const stub = env.EVENT_ROOM.get(env.EVENT_ROOM.idFromName(eventId));
  return stub.fetch(new Request(`https://room/ws?aud=${audience}`, request));
}

type AnnounceRow = GalleryMediaRow & {
  event_id: string;
  join_code: string;
  reveal_mode: string;
  reveal_at: string | null;
};

export async function announceMedia(env: Cloudflare.Env, mediaId: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT m.id, m.event_id, m.kind, m.status, m.hidden, m.width, m.height, m.duration_s, m.taken_at,
       m.created_at, m.poster_url, m.hls_url, m.guest_id, NULL AS display_name,
       e.join_code, e.reveal_mode, e.reveal_at
     FROM media m JOIN events e ON e.id = m.event_id WHERE m.id = ?`,
  )
    .bind(mediaId)
    .first<AnnounceRow>();
  if (!row) return;
  switch (row.status) {
    case "ready": {
      if (row.hidden !== 0) return;
      const event: EventRow = {
        id: row.event_id,
        name: "",
        cover_key: null,
        join_code: row.join_code,
        reveal_mode: row.reveal_mode,
        reveal_at: row.reveal_at,
        video_max_seconds: 0,
      };
      const revealed = isGalleryVisible(event);
      await notifyRoom(
        env,
        row.event_id,
        buildEnvelope({ type: "media.ready", item: toGalleryItem(row, row.join_code) }, revealed),
      );
      return;
    }
    case "failed":
    case "rejected":
      await notifyRoom(
        env,
        row.event_id,
        buildEnvelope({ type: "media.failed", id: row.id }, false),
      );
      return;
    default:
      return;
  }
}
