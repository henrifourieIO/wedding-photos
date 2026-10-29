import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearAccessJwksCacheForTests, verifyAccessJwt } from "../src/lib/auth";

const teamDomain = "test-team.cloudflareaccess.com";
const audience = "test-access-aud";

let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  publicJwk = await exportJWK(keys.publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
});

beforeEach(() => {
  clearAccessJwksCacheForTests();
});

async function signToken(payload: { sub: string; aud?: string; exp?: number }): Promise<string> {
  const builder = new SignJWT({ sub: payload.sub })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(`https://${teamDomain}`)
    .setAudience(payload.aud ?? audience);

  if (payload.exp !== undefined) {
    builder.setExpirationTime(payload.exp);
  } else {
    builder.setExpirationTime("2h");
  }

  return builder.sign(privateKey);
}

function testEnv(overrides?: Partial<Cloudflare.Env>): Cloudflare.Env {
  const base = {
    DB: {} as D1Database,
    PHOTOS: {} as R2Bucket,
    LINKS: {} as KVNamespace,
    PHOTO_QUEUE: {} as Queue,
    EVENT_ROOM: {} as Cloudflare.Env["EVENT_ROOM"],
    ASSETS: {} as Fetcher,
    GUEST_COOKIE_SECRET: "test",
    CF_ACCESS_TEAM_DOMAIN: teamDomain,
    CF_ACCESS_AUD: audience,
  } satisfies Cloudflare.Env;
  return { ...base, ...overrides };
}

describe("verifyAccessJwt", () => {
  it("accepts a valid token", async () => {
    const token = await signToken({ sub: "host@example.com" });
    const jwks = createLocalJWKSet({ keys: [publicJwk] });
    const result = await verifyAccessJwt(token, testEnv(), { jwks });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.sub).toBe("host@example.com");
    }
  });

  it("rejects an expired token", async () => {
    const token = await signToken({
      sub: "host@example.com",
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const jwks = createLocalJWKSet({ keys: [publicJwk] });
    const result = await verifyAccessJwt(token, testEnv(), {
      jwks,
      now: Date.now(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("expired");
    }
  });

  it("rejects wrong audience", async () => {
    const token = await signToken({ sub: "host@example.com", aud: "wrong-aud" });
    const jwks = createLocalJWKSet({ keys: [publicJwk] });
    const result = await verifyAccessJwt(token, testEnv(), { jwks });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("wrong_aud");
    }
  });
});
