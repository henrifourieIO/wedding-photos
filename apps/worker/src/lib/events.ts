import { assertNever, type RevealMode } from "../types";

export type EventRow = {
  id: string;
  name: string;
  cover_key: string | null;
  join_code: string;
  reveal_mode: string;
  reveal_at: string | null;
  video_max_seconds: number;
};

const CODE_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

export function isRevealMode(value: string): value is RevealMode {
  return value === "instant" || value === "delayed" || value === "private";
}

export async function resolveEvent(env: Cloudflare.Env, code: string): Promise<EventRow | null> {
  if (!CODE_PATTERN.test(code)) return null;
  const eventId = await env.LINKS.get(code);
  const columns = "id, name, cover_key, join_code, reveal_mode, reveal_at, video_max_seconds";
  const row = eventId
    ? await env.DB.prepare(`SELECT ${columns} FROM events WHERE id = ?`)
        .bind(eventId)
        .first<EventRow>()
    : await env.DB.prepare(`SELECT ${columns} FROM events WHERE join_code = ?`)
        .bind(code)
        .first<EventRow>();
  return row?.join_code === code ? row : null;
}

export function isGalleryVisible(event: EventRow, now = new Date()): boolean {
  const mode = event.reveal_mode;
  if (!isRevealMode(mode)) return false;
  switch (mode) {
    case "instant":
      return true;
    case "delayed": {
      if (!event.reveal_at) return false;
      const at = Date.parse(event.reveal_at);
      return !Number.isNaN(at) && now.getTime() >= at;
    }
    case "private":
      return false;
    default:
      return assertNever(mode);
  }
}
