import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("POST /api/host/events and GET qr", () => {
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
});
