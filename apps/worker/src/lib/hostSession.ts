import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { fromBase64Url, hmacSha256, toBase64Url, verifyHmacSha256 } from "./crypto";

export const HOST_COOKIE_NAME = "host_session";
export const HOST_SESSION_SECONDS = 7 * 24 * 60 * 60;

export function hostSessionSecret(env: Cloudflare.Env): string | null {
  return env.HOST_SESSION_SECRET || env.HOST_PASSWORD || null;
}

export async function passwordMatches(env: Cloudflare.Env, candidate: string): Promise<boolean> {
  const expected = env.HOST_PASSWORD;
  if (!expected) return false;
  const key = "host-password-compare";
  const [a, b] = await Promise.all([hmacSha256(key, candidate), hmacSha256(key, expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function createHostSessionValue(
  secret: string,
  now: number = Date.now(),
): Promise<string> {
  const exp = Math.floor(now / 1000) + HOST_SESSION_SECONDS;
  const payload = `host.${String(exp)}`;
  const sig = toBase64Url(await hmacSha256(secret, payload));
  return `${String(exp)}.${sig}`;
}

export async function verifyHostSessionValue(
  secret: string,
  value: string,
  now: number = Date.now(),
): Promise<boolean> {
  const [expRaw, sig, extra] = value.split(".");
  if (!expRaw || !sig || extra !== undefined || !/^\d+$/.test(expRaw)) return false;
  if (Number(expRaw) * 1000 <= now) return false;
  const sigBytes = fromBase64Url(sig);
  if (!sigBytes) return false;
  return verifyHmacSha256(secret, `host.${expRaw}`, sigBytes);
}

export async function hasValidHostSession(request: Request, env: Cloudflare.Env): Promise<boolean> {
  const secret = hostSessionSecret(env);
  if (!secret) return false;
  const header = request.headers.get("Cookie");
  if (!header) return false;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== HOST_COOKIE_NAME) continue;
    if (await verifyHostSessionValue(secret, part.slice(idx + 1).trim())) return true;
  }
  return false;
}

export async function setHostSessionCookie(c: Context, secret: string): Promise<void> {
  setCookie(c, HOST_COOKIE_NAME, await createHostSessionValue(secret), {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    maxAge: HOST_SESSION_SECONDS,
  });
}

export function clearHostSessionCookie(c: Context): void {
  deleteCookie(c, HOST_COOKIE_NAME, { path: "/" });
}
