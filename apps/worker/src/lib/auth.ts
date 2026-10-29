import { createRemoteJWKSet, jwtVerify, errors, type JWTVerifyGetKey } from "jose";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

const JWKS_CACHE_MS = 60 * 60 * 1000;

type JwksCacheEntry = {
  jwks: JWTVerifyGetKey;
  fetchedAt: number;
};

const jwksByTeam = new Map<string, JwksCacheEntry>();

export type HostIdentity = {
  sub: string;
};

export type AccessVerifyResult =
  { ok: true; identity: HostIdentity } | { ok: false; reason: string };

function accessIssuer(teamDomain: string): string {
  return `https://${teamDomain}`;
}

function certsUrl(teamDomain: string): string {
  return `https://${teamDomain}/cdn-cgi/access/certs`;
}

function getCachedJwks(teamDomain: string): JWTVerifyGetKey {
  const now = Date.now();
  const cached = jwksByTeam.get(teamDomain);
  if (cached && now - cached.fetchedAt < JWKS_CACHE_MS) {
    return cached.jwks;
  }
  const jwks = createRemoteJWKSet(new URL(certsUrl(teamDomain)));
  jwksByTeam.set(teamDomain, { jwks, fetchedAt: now });
  return jwks;
}

export function clearAccessJwksCacheForTests(): void {
  jwksByTeam.clear();
}

export async function verifyAccessJwt(
  token: string,
  env: Cloudflare.Env,
  options?: { now?: number; jwks?: JWTVerifyGetKey },
): Promise<AccessVerifyResult> {
  if (env.DEV_BYPASS_ACCESS === "true") {
    return { ok: true, identity: { sub: "dev-bypass" } };
  }

  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!teamDomain || !aud) {
    return { ok: false, reason: "access_not_configured" };
  }

  const jwks = options?.jwks ?? getCachedJwks(teamDomain);

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: accessIssuer(teamDomain),
      audience: aud,
      clockTolerance: 30,
      currentDate: options?.now ? new Date(options.now) : undefined,
    });
    const sub = payload.sub;
    if (!sub) {
      return { ok: false, reason: "missing_sub" };
    }
    return { ok: true, identity: { sub } };
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      return { ok: false, reason: "expired" };
    }
    if (error instanceof errors.JWTClaimValidationFailed && error.claim === "aud") {
      return { ok: false, reason: "wrong_aud" };
    }
    const message = error instanceof Error ? error.message : "invalid_token";
    if (message.includes("exp") || message.includes("expired")) {
      return { ok: false, reason: "expired" };
    }
    if (message.includes("aud") || message.includes("audience")) {
      return { ok: false, reason: "wrong_aud" };
    }
    return { ok: false, reason: "invalid_token" };
  }
}

export function readAccessJwtFromRequest(request: Request): string | null {
  return request.headers.get("Cf-Access-Jwt-Assertion");
}

export async function authenticateHostRequest(
  request: Request,
  env: Cloudflare.Env,
  options?: { now?: number; jwks?: JWTVerifyGetKey },
): Promise<AccessVerifyResult> {
  const token = readAccessJwtFromRequest(request);
  if (!token) {
    if (env.DEV_BYPASS_ACCESS === "true") {
      return { ok: true, identity: { sub: "dev-bypass" } };
    }
    return { ok: false, reason: "missing_token" };
  }
  return verifyAccessJwt(token, env, options);
}

export function hostAccessHint(reason: string): string | undefined {
  switch (reason) {
    case "missing_token":
      return "Add /api/host (and /api/host/*) to the same Access application as /host on this hostname. The SPA calls /api/host/*; without Access on that path, Cf-Access-Jwt-Assertion is not sent.";
    case "access_not_configured":
      return "Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD on the production Worker (wrangler secret or dashboard vars for env production).";
    case "wrong_aud":
      return "CF_ACCESS_AUD must exactly match the Access application's AUD tag (Application → Overview → AUD).";
    case "expired":
      return "Access session expired; refresh the page and sign in again.";
    default:
      return undefined;
  }
}

export function hostAccessAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const result = await authenticateHostRequest(c.req.raw, c.env);
    if (!result.ok) {
      const hint = hostAccessHint(result.reason);
      return c.json(
        hint ? { error: "unauthorized", reason: result.reason, hint } : { error: "unauthorized", reason: result.reason },
        401,
      );
    }
    c.set("hostSub", result.identity.sub);
    await next();
  };
}
