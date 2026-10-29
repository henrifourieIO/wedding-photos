import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { authenticateHostRequest } from "../src/lib/auth";
import { createHostSessionValue, verifyHostSessionValue } from "../src/lib/hostSession";

const PASSWORD = "correct horse";

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function login(password: unknown): Promise<Response> {
  return call(
    new Request("http://example.com/api/host/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }),
  );
}

const prev = {
  bypass: env.DEV_BYPASS_ACCESS,
  password: env.HOST_PASSWORD,
  secret: env.HOST_SESSION_SECRET,
};

beforeEach(() => {
  env.DEV_BYPASS_ACCESS = undefined;
  env.HOST_PASSWORD = PASSWORD;
  env.HOST_SESSION_SECRET = undefined;
});

afterEach(() => {
  env.DEV_BYPASS_ACCESS = prev.bypass;
  env.HOST_PASSWORD = prev.password;
  env.HOST_SESSION_SECRET = prev.secret;
});

describe("host password login", () => {
  it("sets a signed HttpOnly cookie on success", async () => {
    const res = await login(PASSWORD);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("host_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=604800");
  });

  it("rejects a wrong or missing password", async () => {
    const bad = await login("nope");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("Set-Cookie")).toBeNull();
    expect((await login(undefined)).status).toBe(401);
  });

  it("returns 503 when no password is configured", async () => {
    env.HOST_PASSWORD = undefined;
    expect((await login("x")).status).toBe(503);
  });

  it("creates an event with the session cookie and rejects without it", async () => {
    const cookie = (await login(PASSWORD)).headers.get("Set-Cookie")?.split(";")[0] ?? "";
    const body = JSON.stringify({ name: "Cookie event", revealMode: "instant" });
    const headers = { "Content-Type": "application/json" };

    const anon = await call(
      new Request("http://example.com/api/host/events", { method: "POST", headers, body }),
    );
    expect(anon.status).toBe(401);

    const ok = await call(
      new Request("http://example.com/api/host/events", {
        method: "POST",
        headers: { ...headers, Cookie: cookie },
        body,
      }),
    );
    expect(ok.status).toBe(201);
  });

  it("rejects tampered and expired cookies", async () => {
    const value = await createHostSessionValue(PASSWORD);
    expect(await verifyHostSessionValue(PASSWORD, value)).toBe(true);
    expect(await verifyHostSessionValue("other", value)).toBe(false);
    expect(await verifyHostSessionValue(PASSWORD, `${value}x`)).toBe(false);
    const old = await createHostSessionValue(PASSWORD, Date.now() - 8 * 24 * 3600 * 1000);
    expect(await verifyHostSessionValue(PASSWORD, old)).toBe(false);
  });

  it("uses HOST_SESSION_SECRET when set", async () => {
    env.HOST_SESSION_SECRET = "separate-secret";
    const cookie = (await login(PASSWORD)).headers.get("Set-Cookie")?.split(";")[0] ?? "";
    const res = await call(
      new Request("http://example.com/api/host/events", { headers: { Cookie: cookie } }),
    );
    expect(res.status).toBe(200);
    env.HOST_SESSION_SECRET = "rotated";
    const stale = await call(
      new Request("http://example.com/api/host/events", { headers: { Cookie: cookie } }),
    );
    expect(stale.status).toBe(401);
  });

  it("still accepts a valid Access JWT when configured", async () => {
    const teamDomain = "t.cloudflareaccess.com";
    const aud = "aud-1";
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "k";
    jwk.alg = "RS256";
    const token = await new SignJWT({ sub: "host@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer(`https://${teamDomain}`)
      .setAudience(aud)
      .setExpirationTime("2h")
      .sign(privateKey);
    const accessEnv = { ...env, CF_ACCESS_TEAM_DOMAIN: teamDomain, CF_ACCESS_AUD: aud };
    const req = new Request("http://example.com/api/host/events", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const result = await authenticateHostRequest(req, accessEnv, {
      jwks: createLocalJWKSet({ keys: [jwk] }),
    });
    expect(result.ok).toBe(true);
  });
});
