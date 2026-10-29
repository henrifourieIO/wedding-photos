import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  classifyWebhook,
  signWebhook,
  verifyWebhookSignature,
  TUS_THRESHOLD_BYTES,
} from "../src/lib/stream";

const EVENT_ID = "evt-v";
const CODE = "vid123";

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function json(path: string, body: unknown, cookie?: string): Request {
  return new Request(`http://example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function joinAs(name: string): Promise<string> {
  const res = await call(json(`/api/events/${CODE}/guests`, { display_name: name }));
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM media"),
    env.DB.prepare("DELETE FROM guests"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare(
      "INSERT INTO events (id, host_sub, name, join_code, video_max_seconds) VALUES (?, 'h', 'W', ?, 30)",
    ).bind(EVENT_ID, CODE),
  ]);
  await env.LINKS.put(CODE, EVENT_ID);
});

function firstCall(spy: { mock: { calls: unknown[][] } }): { url: string; init: RequestInit } {
  const [input, init] = spy.mock.calls[0] ?? [];
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : "";
  return { url, init: init ?? {} };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("webhook signature", () => {
  const body = '{"uid":"u1"}';
  const now = 1_800_000_000;

  it("accepts a valid signature", async () => {
    const sig = await signWebhook("s", now, body);
    expect(await verifyWebhookSignature("s", `time=${String(now)},sig1=${sig}`, body, now)).toBe(
      "valid",
    );
  });

  it("rejects bad signatures and tampered bodies", async () => {
    const sig = await signWebhook("s", now, body);
    const header = `time=${String(now)},sig1=${sig}`;
    expect(await verifyWebhookSignature("other", header, body, now)).toBe("mismatch");
    expect(await verifyWebhookSignature("s", header, `${body} `, now)).toBe("mismatch");
    expect(await verifyWebhookSignature("s", "garbage", body, now)).toBe("malformed");
    expect(await verifyWebhookSignature("s", null, body, now)).toBe("malformed");
  });

  it("rejects stale timestamps", async () => {
    const sig = await signWebhook("s", now, body);
    expect(
      await verifyWebhookSignature("s", `time=${String(now)},sig1=${sig}`, body, now + 301),
    ).toBe("stale");
    expect(
      await verifyWebhookSignature("s", `time=${String(now)},sig1=${sig}`, body, now + 299),
    ).toBe("valid");
  });
});

describe("video uploads", () => {
  const video = { kind: "video", content_type: "video/quicktime", size: 5_000_000 };

  it("creates a basic direct upload and a pending row", async () => {
    const cookie = await joinAs("Vic");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        success: true,
        result: { uploadURL: "https://upload.example/x", uid: "uid1" },
      }),
    );
    const res = await call(json(`/api/events/${CODE}/uploads`, video, cookie));
    expect(res.status).toBe(201);
    const out = await res.json<{ uploadUrl: string; mediaId: string }>();
    expect(out.uploadUrl).toBe("https://upload.example/x");

    const { url, init } = firstCall(fetchSpy);
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/stream/direct_upload");
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({
      maxDurationSeconds: 30,
      requireSignedURLs: false,
      meta: { event_id: EVENT_ID, media_id: out.mediaId },
    });

    const row = await env.DB.prepare("SELECT kind, status, stream_uid FROM media WHERE id = ?")
      .bind(out.mediaId)
      .first();
    expect(row).toEqual({ kind: "video", status: "pending", stream_uid: "uid1" });
  });

  it("uses tus above 200 MB", async () => {
    const cookie = await joinAs("Tus");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 201,
        headers: { location: "https://upload.example/tus/1", "stream-media-id": "uid2" },
      }),
    );
    const res = await call(
      json(`/api/events/${CODE}/uploads`, { ...video, size: TUS_THRESHOLD_BYTES + 1 }, cookie),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      uploadUrl: "https://upload.example/tus/1",
      protocol: "tus",
    });
    const { url, init } = firstCall(fetchSpy);
    expect(url).toContain("/stream?direct_user=true");
    expect(new Headers(init.headers).get("upload-length")).toBe(String(TUS_THRESHOLD_BYTES + 1));
  });

  it("validates type and surfaces Stream failures", async () => {
    const cookie = await joinAs("Bad");
    const path = `/api/events/${CODE}/uploads`;
    expect((await call(json(path, { ...video, content_type: "video/avi" }, cookie))).status).toBe(
      415,
    );
    expect((await call(json(path, { ...video, size: 0 }, cookie))).status).toBe(400);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 500 }));
    expect((await call(json(path, video, cookie))).status).toBe(502);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM media").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});

describe("stream webhook route", () => {
  async function seed(status = "pending") {
    await env.DB.prepare(
      "INSERT INTO media (id, event_id, kind, stream_uid, status) VALUES ('m1', ?, 'video', 'uid1', ?)",
    )
      .bind(EVENT_ID, status)
      .run();
  }

  async function send(payload: unknown, secret = "whsec", time = Math.floor(Date.now() / 1000)) {
    const body = JSON.stringify(payload);
    const sig = await signWebhook(secret, time, body);
    return call(
      new Request("http://example.com/api/webhooks/stream", {
        method: "POST",
        headers: { "webhook-signature": `time=${String(time)},sig1=${sig}` },
        body,
      }),
    );
  }

  const readyPayload = {
    uid: "uid1",
    readyToStream: true,
    status: { state: "ready" },
    thumbnail: "https://cf/thumb.jpg",
    duration: 12.5,
    playback: { hls: "https://cf/v.m3u8", dash: "https://cf/v.mpd" },
  };

  it("rejects unsigned, wrongly signed and stale requests", async () => {
    await seed();
    expect((await send(readyPayload, "wrong")).status).toBe(401);
    expect((await send(readyPayload, "whsec", Math.floor(Date.now() / 1000) - 600)).status).toBe(
      401,
    );
    const bare = await call(
      new Request("http://example.com/api/webhooks/stream", { method: "POST", body: "{}" }),
    );
    expect(bare.status).toBe(401);
    const row = await env.DB.prepare("SELECT status FROM media WHERE id='m1'").first();
    expect(row).toEqual({ status: "pending" });
  });

  it("marks ready with playback data, idempotently", async () => {
    await seed();
    expect((await send(readyPayload)).status).toBe(200);
    expect((await send(readyPayload)).status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT status, duration_s, poster_url, hls_url, dash_url FROM media WHERE id='m1'",
    ).first();
    expect(row).toEqual({
      status: "ready",
      duration_s: 12.5,
      poster_url: "https://cf/thumb.jpg",
      hls_url: "https://cf/v.m3u8",
      dash_url: "https://cf/v.mpd",
    });
  });

  it("marks failed on error but never downgrades ready", async () => {
    await seed();
    await send({
      uid: "uid1",
      status: { state: "error", errorReasonCode: "ERR_DURATION_EXCEED_CONSTRAINT" },
    });
    expect(await env.DB.prepare("SELECT status FROM media WHERE id='m1'").first()).toEqual({
      status: "failed",
    });
    await send(readyPayload);
    expect(await env.DB.prepare("SELECT status FROM media WHERE id='m1'").first()).toEqual({
      status: "ready",
    });
    await send({ uid: "uid1", status: { state: "error" } });
    expect(await env.DB.prepare("SELECT status FROM media WHERE id='m1'").first()).toEqual({
      status: "ready",
    });
  });

  it("ignores in-progress notifications", () => {
    expect(
      classifyWebhook({ uid: "u", readyToStream: false, status: { state: "inprogress" } }),
    ).toEqual({
      type: "ignore",
    });
  });
});
