import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("POST /api/host/events and GET qr", () => {
  it("creates an event without a cover when coverContentType is omitted", async () => {
    const createReq = new Request("http://example.com/api/host/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ceremony",
        revealMode: "instant",
      }),
    });
    const ctx = createExecutionContext();
    const createRes = await worker.fetch(createReq, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(createRes.status).toBe(201);
    const created: {
      event: { id: string; name: string; coverUpload?: unknown; coverUrl?: string | null };
    } = await createRes.json();
    expect(created.event.name).toBe("Ceremony");
    expect(created.event.coverUpload).toBeUndefined();
    expect(created.event.coverUrl ?? null).toBeNull();
  });

  it("creates an event and returns SVG QR", async () => {
    const createReq = new Request("http://example.com/api/host/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ceremony",
        revealMode: "instant",
      }),
    });
    const ctx = createExecutionContext();
    const createRes = await worker.fetch(createReq, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(createRes.status).toBe(201);
    const created: { event: { id: string; name: string; joinCode: string; guestUrl: string } } =
      await createRes.json();
    expect(created.event.name).toBe("Ceremony");
    expect(created.event.id).toBeTruthy();
    expect(created.event.joinCode).toBeTruthy();
    expect(created.event.guestUrl).toContain("/e/");

    const kvEventId = await env.LINKS.get(created.event.joinCode);
    expect(kvEventId).toBe(created.event.id);

    const qrReq = new Request(`http://example.com/api/host/events/${created.event.id}/qr`);
    const qrCtx = createExecutionContext();
    const qrRes = await worker.fetch(qrReq, env, qrCtx);
    await waitOnExecutionContext(qrCtx);
    expect(qrRes.status).toBe(200);
    expect(qrRes.headers.get("Content-Type")).toContain("image/svg+xml");
    const svg = await qrRes.text();
    expect(svg).toContain("<svg");
    expect(created.event.guestUrl).toContain(`/e/${created.event.joinCode}`);
  });

  it("rejects host routes when bypass is off and token missing", async () => {
    const prev = env.DEV_BYPASS_ACCESS;
    env.DEV_BYPASS_ACCESS = undefined;
    try {
      const req = new Request("http://example.com/api/host/events");
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(401);
    } finally {
      env.DEV_BYPASS_ACCESS = prev;
    }
  });

  it("returns 503 when cover is requested but R2 S3 keys are missing", async () => {
    const prevAccount = env.R2_ACCOUNT_ID;
    const prevKey = env.R2_ACCESS_KEY_ID;
    const prevSecret = env.R2_SECRET_ACCESS_KEY;
    env.R2_ACCOUNT_ID = undefined;
    env.R2_ACCESS_KEY_ID = undefined;
    env.R2_SECRET_ACCESS_KEY = undefined;
    try {
      const req = new Request("http://example.com/api/host/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "With cover",
          revealMode: "instant",
          coverContentType: "image/jpeg",
        }),
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(503);
      const body: { error: string; reason: string; hint: string } = await res.json();
      expect(body.error).toBe("cover_presign_unavailable");
      expect(body.reason).toContain("R2");
      expect(body.hint).toContain("R2_ACCOUNT_ID");
    } finally {
      env.R2_ACCOUNT_ID = prevAccount;
      env.R2_ACCESS_KEY_ID = prevKey;
      env.R2_SECRET_ACCESS_KEY = prevSecret;
    }
  });
});
