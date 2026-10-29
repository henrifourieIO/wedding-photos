import type { EventRow, HostEventDto, RevealMode } from "../types";
import { assertNever } from "../types";

export function generateJoinCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const bin = String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateEventId(): string {
  return crypto.randomUUID();
}

export function parseRevealMode(value: unknown): RevealMode | null {
  if (value === "instant" || value === "delayed" || value === "private") {
    return value;
  }
  return null;
}

export function validateRevealAt(mode: RevealMode, revealAt: unknown): string | null {
  switch (mode) {
    case "instant":
    case "private":
      return null;
    case "delayed": {
      if (typeof revealAt !== "string" || revealAt.length === 0) {
        return null;
      }
      return revealAt;
    }
    default:
      return assertNever(mode);
  }
}

export function rowToHostEvent(row: EventRow, guestUrl: string): HostEventDto {
  return {
    id: row.id,
    name: row.name,
    startsAt: row.starts_at,
    coverKey: row.cover_key,
    joinCode: row.join_code,
    revealMode: row.reveal_mode,
    revealAt: row.reveal_at,
    videoMaxSeconds: row.video_max_seconds,
    createdAt: row.created_at,
    guestUrl,
  };
}

export function guestPath(joinCode: string): string {
  return `/e/${joinCode}`;
}

export function guestUrlFromRequest(requestUrl: string, joinCode: string): string {
  const url = new URL(requestUrl);
  return `${url.origin}${guestPath(joinCode)}`;
}
