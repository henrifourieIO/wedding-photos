import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { PhotoQueueMessage } from "../src/types";
import worker from "../src/index";
import { createGuestCookieValue, verifyGuestCookieValue } from "../src/lib/guest";
import { consumeRateLimit } from "../src/lib/ratelimit";

type TestEnv = Cloudflare.Env;

async function call(request: Request, testEnv: TestEnv = env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, testEnv, ctx);
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

async function joinAs(code: string, name: string): Promise<string> {
  const res = await call(json(`/api/events/${code}/guests`, { display_name: name }));
  expect(res.status).toBe(201);
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0] ?? "";
}

const EVENT_ID = "evt-1";
const CODE = "abc123";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM media"),
    env.DB.prepare("DELETE FROM guests"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare(
      "INSERT INTO events (id, host_sub, name, join_code, reveal_mode, video_max_seconds) VALUES (?, 'h', 'Our Wedding', ?, 'instant', 45)",
    ).bind(EVENT_ID, CODE),
  ]);
  await env.LINKS.put(CODE, EVENT_ID);
});

describe("event resolution", () => {
  it("returns public info for a known code", async () => {
    const res = await call(new Request(`http://example.com/api/events/${CODE}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "Our Wedding",
      cover_url: null,
      reveal_mode: "instant",
      gallery_visible: true,
      video_max_seconds: 45,
    });
  });

  it("returns an identical 404 for unknown and malformed codes", async () => {
    const a = await call(new Request("http://example.com/api/events/nope12"));
    const b = await call(new Request("http://example.com/api/events/..%2F"));
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await a.text()).toBe(await b.text());
  });

  it("hides the gallery for delayed events before reveal time", async () => {
    await env.DB.prepare("UPDATE events SET reveal_mode='delayed', reveal_at=? WHERE id=?")
      .bind(new Date(Date.now() + 3_600_000).toISOString(), EVENT_ID)
      .run();
    const body = await (
      await call(new Request(`http://example.com/api/events/${CODE}`))
    ).json<{
      gallery_visible: boolean;
    }>();
    expect(body.gallery_visible).toBe(false);
  });
});

describe("guest cookie", () => {
  it("sets a signed HttpOnly Lax cookie and stores only the token hash", async () => {
    const res = await call(json(`/api/events/${CODE}/guests`, { display_name: "  Alice  " }));
    expect(res.status).toBe(201);
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    const value = header.split(";")[0]?.split("=")[1] ?? "";
    const token = value.split(".")[1] ?? "";
    const row = await env.DB.prepare("SELECT display_name, cookie_token_hash FROM guests").first<{
      display_name: string;
      cookie_token_hash: string;
    }>();
    expect(row?.display_name).toBe("Alice");
    expect(row?.cookie_token_hash).not.toBe(token);
    expect(row?.cookie_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects blank names", async () => {
    const res = await call(json(`/api/events/${CODE}/guests`, { display_name: "   " }));
    expect(res.status).toBe(400);
  });

  it("verifies signature and event binding", async () => {
    const value = await createGuestCookieValue("s", "e1", "g1", "tok");
    expect(await verifyGuestCookieValue("s", "e1", value)).toEqual({ guestId: "g1", token: "tok" });
    expect(await verifyGuestCookieValue("s", "e2", value)).toBeNull();
    expect(await verifyGuestCookieValue("other", "e1", value)).toBeNull();
    expect(await verifyGuestCookieValue("s", "e1", value.replace("tok", "tox"))).toBeNull();
    expect(await verifyGuestCookieValue("s", "e1", "garbage")).toBeNull();
  });

  it("rejects a tampered cookie on /me", async () => {
    const cookie = await joinAs(CODE, "Bob");
    const ok = await call(
      new Request(`http://example.com/api/events/${CODE}/me`, { headers: { cookie } }),
    );
    expect(ok.status).toBe(200);
    const bad = await call(
      new Request(`http://example.com/api/events/${CODE}/me`, {
        headers: { cookie: `${cookie}x` },
      }),
    );
    expect(bad.status).toBe(401);
  });
});

describe("uploads", () => {
  const photo = { kind: "photo", content_type: "image/jpeg", size: 1024 };

  it("requires a guest cookie", async () => {
    const res = await call(json(`/api/events/${CODE}/uploads`, photo));
    expect(res.status).toBe(401);
  });

  it("validates type, size and kind", async () => {
    const cookie = await joinAs(CODE, "Carol");
    const path = `/api/events/${CODE}/uploads`;
    expect((await call(json(path, { ...photo, content_type: "image/gif" }, cookie))).status).toBe(
      415,
    );
    expect((await call(json(path, { ...photo, size: 26 * 1024 * 1024 }, cookie))).status).toBe(413);
    expect((await call(json(path, { ...photo, size: 0 }, cookie))).status).toBe(400);
  });

  it("creates, uploads via proxy, completes, enqueues and lists", async () => {
    const cookie = await joinAs(CODE, "Dave");
    const created = await call(json(`/api/events/${CODE}/uploads`, photo, cookie));
    expect(created.status).toBe(201);
    const { id, mode, upload } = await created.json<{
      id: string;
      mode: string;
      upload: { url: string; headers: Record<string, string> };
    }>();
    expect(mode).toBe("proxy");

    const row = await env.DB.prepare("SELECT r2_key, status FROM media WHERE id = ?")
      .bind(id)
      .first<{ r2_key: string; status: string }>();
    expect(row).toEqual({ r2_key: `events/${EVENT_ID}/orig/${id}.jpg`, status: "pending" });

    const early = await call(
      new Request(`http://example.com/api/events/${CODE}/uploads/${id}/complete`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(early.status).toBe(409);

    const bytes = new Uint8Array(1024).fill(7);
    const put = await call(
      new Request(`http://example.com${upload.url}`, {
        method: "PUT",
        headers: { ...upload.headers, cookie, "content-length": "1024" },
        body: bytes,
      }),
    );
    expect(put.status).toBe(204);

    const sent: PhotoQueueMessage[] = [];
    const queue = {
      send: (m: PhotoQueueMessage) => {
        sent.push(m);
        return Promise.resolve();
      },
    } as unknown as Queue<PhotoQueueMessage>;
    const completeEnv: TestEnv = { ...env, PHOTO_QUEUE: queue };
    const completeReq = () =>
      new Request(`http://example.com/api/events/${CODE}/uploads/${id}/complete`, {
        method: "POST",
        headers: { cookie },
      });
    const done = await call(completeReq(), completeEnv);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ id, status: "uploaded", size: 1024 });
    await call(completeReq(), completeEnv);
    expect(sent).toEqual([{ mediaId: id, eventId: EVENT_ID }]);

    const listed = await call(
      new Request(`http://example.com/api/events/${CODE}/me/media`, { headers: { cookie } }),
    );
    const { media } = await listed.json<{ media: { id: string; status: string }[] }>();
    expect(media.map((m) => [m.id, m.status])).toEqual([[id, "uploaded"]]);
  });

  it("does not let another guest complete or list foreign uploads", async () => {
    const a = await joinAs(CODE, "A");
    const b = await joinAs(CODE, "B");
    const created = await call(json(`/api/events/${CODE}/uploads`, photo, a));
    const { id } = await created.json<{ id: string }>();
    const res = await call(
      new Request(`http://example.com/api/events/${CODE}/uploads/${id}/complete`, {
        method: "POST",
        headers: { cookie: b },
      }),
    );
    expect(res.status).toBe(404);
    const listed = await call(
      new Request(`http://example.com/api/events/${CODE}/me/media`, { headers: { cookie: b } }),
    );
    expect((await listed.json<{ media: unknown[] }>()).media).toEqual([]);
  });

  it("returns a presigned URL when S3 keys are configured", async () => {
    const cookie = await joinAs(CODE, "Erin");
    const s3Env: TestEnv = {
      ...env,
      R2_ACCOUNT_ID: "acc",
      R2_ACCESS_KEY_ID: "AK",
      R2_SECRET_ACCESS_KEY: "SK",
    };
    const res = await call(json(`/api/events/${CODE}/uploads`, photo, cookie), s3Env);
    const body = await res.json<{ mode: string; upload: { url: string } }>();
    expect(body.mode).toBe("presigned");
    expect(body.upload.url).toContain(
      "acc.r2.cloudflarestorage.com/wedding-photos/events/evt-1/orig/",
    );
  });
});

describe("rate limit", () => {
  it("blocks after the limit within a window", async () => {
    const now = Date.UTC(2025, 0, 1);
    for (let i = 0; i < 3; i++) {
      expect((await consumeRateLimit(env.LINKS, "t", 3, 600, now)).allowed).toBe(true);
    }
    expect((await consumeRateLimit(env.LINKS, "t", 3, 600, now)).allowed).toBe(false);
    expect((await consumeRateLimit(env.LINKS, "t", 3, 600, now + 601_000)).allowed).toBe(true);
  });

  it("returns 429 on the upload endpoint when exhausted", async () => {
    const cookie = await joinAs(CODE, "Fay");
    const me = await (
      await call(new Request(`http://example.com/api/events/${CODE}/me`, { headers: { cookie } }))
    ).json<{ id: string }>();
    const window = Math.floor(Date.now() / 1000 / 600);
    await env.LINKS.put(`rl:upload:${me.id}:${String(window)}`, "60");
    const res = await call(
      json(
        `/api/events/${CODE}/uploads`,
        { kind: "photo", content_type: "image/png", size: 10 },
        cookie,
      ),
    );
    expect(res.status).toBe(429);
  });
});
