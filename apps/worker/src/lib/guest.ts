import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  fromBase64Url,
  hmacSha256,
  randomToken,
  sha256Hex,
  toBase64Url,
  verifyHmacSha256,
} from "./crypto";

export type GuestRow = { id: string; event_id: string; display_name: string };

export class GuestCookieSecretMissingError extends Error {
  override readonly name = "GuestCookieSecretMissingError";
}

export const GUEST_COOKIE_SECRET_SETUP_HINT =
  "Set GUEST_COOKIE_SECRET: pnpm exec wrangler secret put GUEST_COOKIE_SECRET --cwd apps/worker --env production";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function requireGuestCookieSecret(secret: string | undefined): string {
  if (!secret) throw new GuestCookieSecretMissingError();
  return secret;
}

export function guestCookieName(code: string): string {
  return `wp_guest_${code}`;
}

function signingPayload(eventId: string, guestId: string, token: string): string {
  return `v1.${eventId}.${guestId}.${token}`;
}

export async function createGuestCookieValue(
  secret: string,
  eventId: string,
  guestId: string,
  token: string,
): Promise<string> {
  const sig = await hmacSha256(secret, signingPayload(eventId, guestId, token));
  return `${guestId}.${token}.${toBase64Url(sig)}`;
}

export type ParsedGuestCookie = { guestId: string; token: string };

export async function verifyGuestCookieValue(
  secret: string,
  eventId: string,
  value: string,
): Promise<ParsedGuestCookie | null> {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [guestId, token, sig] = parts;
  if (!guestId || !token || !sig) return null;
  const sigBytes = fromBase64Url(sig);
  if (!sigBytes) return null;
  const ok = await verifyHmacSha256(secret, signingPayload(eventId, guestId, token), sigBytes);
  return ok ? { guestId, token } : null;
}

export async function issueGuest(
  c: Context<{ Bindings: Cloudflare.Env }>,
  code: string,
  eventId: string,
  displayName: string,
): Promise<GuestRow> {
  const cookieSecret = requireGuestCookieSecret(c.env.GUEST_COOKIE_SECRET);
  const guestId = crypto.randomUUID();
  const token = randomToken();
  await c.env.DB.prepare(
    "INSERT INTO guests (id, event_id, display_name, cookie_token_hash) VALUES (?, ?, ?, ?)",
  )
    .bind(guestId, eventId, displayName, await sha256Hex(token))
    .run();
  const value = await createGuestCookieValue(cookieSecret, eventId, guestId, token);
  setCookie(c, guestCookieName(code), value, {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/api",
    maxAge: COOKIE_MAX_AGE,
  });
  return { id: guestId, event_id: eventId, display_name: displayName };
}

export async function authenticateGuest(
  c: Context<{ Bindings: Cloudflare.Env }>,
  code: string,
  eventId: string,
): Promise<GuestRow | null> {
  const raw = getCookie(c, guestCookieName(code));
  if (!raw) return null;
  const cookieSecret = c.env.GUEST_COOKIE_SECRET;
  if (!cookieSecret) return null;
  const parsed = await verifyGuestCookieValue(cookieSecret, eventId, raw);
  if (!parsed) return null;
  const row = await c.env.DB.prepare(
    "SELECT id, event_id, display_name, cookie_token_hash FROM guests WHERE id = ? AND event_id = ?",
  )
    .bind(parsed.guestId, eventId)
    .first<GuestRow & { cookie_token_hash: string }>();
  if (!row) return null;
  if (row.cookie_token_hash !== (await sha256Hex(parsed.token))) return null;
  return { id: row.id, event_id: row.event_id, display_name: row.display_name };
}

export function normalizeDisplayName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const printable = Array.from(input, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || code === 127 ? " " : ch;
  }).join("");
  const cleaned = printable.replace(/\s+/g, " ").trim();
  if (cleaned.length < 1 || cleaned.length > 60) return null;
  return cleaned;
}
