import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { jpeg } from "./fixtures";

const EVENT_ID = "evt-g";
const CODE = "gal123";

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function seedReadyPhoto(id: string, hidden = 0): Promise<void> {
  const bytes = jpeg(400, 300);
  const orig = `events/${EVENT_ID}/orig/${id}.jpg`;
  const thumb = `events/${EVENT_ID}/thumb/${id}.jpg`;
  const web = `events/${EVENT_ID}/web/${id}.jpg`;
  await env.PHOTOS.put(orig, bytes);
  await env.PHOTOS.put(thumb, bytes);
  await env.PHOTOS.put(web, bytes);
  await env.DB.prepare(
    `INSERT INTO media (id, event_id, kind, r2_key, thumb_key, web_key, status, hidden, content_type, size_bytes, created_at)
     VALUES (?, ?, 'photo', ?, ?, ?, 'ready', ?, 'image/jpeg', ?, datetime('now'))`,
  )
    .bind(id, EVENT_ID, orig, thumb, web, hidden, bytes.length)
    .run();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM media"),
    env.DB.prepare("DELETE FROM guests"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare(
      "INSERT INTO events (id, host_sub, name, join_code, reveal_mode, video_max_seconds) VALUES (?, 'dev-bypass', 'Gallery Test', ?, 'instant', 60)",
    ).bind(EVENT_ID, CODE),
  ]);
  await env.LINKS.put(CODE, EVENT_ID);
});

describe("GET /api/events/:code/gallery", () => {
  it("lists ready, visible photos when reveal is instant", async () => {
    await seedReadyPhoto("p1");
    const res = await call(new Request(`http://example.com/api/events/${CODE}/gallery`));
    expect(res.status).toBe(200);
    const body = await res.json<{
      gallery_visible: boolean;
      items: { id: string; kind: string; thumb_url: string }[];
    }>();
    expect(body.gallery_visible).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe("p1");
    expect(body.items[0]?.thumb_url).toContain("/media/p1/thumb");
  });

  it("returns empty items before delayed reveal time", async () => {
    await seedReadyPhoto("p2");
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await env.DB.prepare("UPDATE events SET reveal_mode='delayed', reveal_at=? WHERE id=?")
      .bind(future, EVENT_ID)
      .run();
    const body = await (
      await call(new Request(`http://example.com/api/events/${CODE}/gallery`))
    ).json<{ gallery_visible: boolean; items: unknown[]; reveal_at: string }>();
    expect(body.gallery_visible).toBe(false);
    expect(body.items).toEqual([]);
    expect(body.reveal_at).toBe(future);
  });

  it("hides private albums from guests", async () => {
    await seedReadyPhoto("p3");
    await env.DB.prepare("UPDATE events SET reveal_mode='private' WHERE id=?").bind(EVENT_ID).run();
    const body = await (
      await call(new Request(`http://example.com/api/events/${CODE}/gallery`))
    ).json<{ gallery_visible: boolean; items: unknown[] }>();
    expect(body.gallery_visible).toBe(false);
    expect(body.items).toEqual([]);
  });

  it("omits host-hidden media", async () => {
    await seedReadyPhoto("vis", 0);
    await seedReadyPhoto("hid", 1);
    const body = await (
      await call(new Request(`http://example.com/api/events/${CODE}/gallery`))
    ).json<{ items: { id: string }[] }>();
    expect(body.items.map((i) => i.id)).toEqual(["vis"]);
  });
});

describe("host moderation", () => {
  it("lists all media including hidden and pending", async () => {
    await seedReadyPhoto("r1", 1);
    await env.DB.prepare(
      "INSERT INTO media (id, event_id, kind, status, hidden) VALUES ('pend', ?, 'photo', 'pending', 0)",
    )
      .bind(EVENT_ID)
      .run();
    const res = await call(new Request(`http://example.com/api/host/events/${EVENT_ID}/media`));
    expect(res.status).toBe(200);
    const { media } = await res.json<{ media: { id: string; status: string; hidden: boolean }[] }>();
    expect(media.map((m) => [m.id, m.status, m.hidden])).toEqual(
      expect.arrayContaining([
        ["r1", "ready", true],
        ["pend", "pending", false],
      ]),
    );
  });

  it("hide/unhide toggles guest visibility", async () => {
    await seedReadyPhoto("toggle");
    const hide = await call(
      new Request(`http://example.com/api/host/events/${EVENT_ID}/media/toggle`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden: true }),
      }),
    );
    expect(hide.status).toBe(200);
    let listed = await (
      await call(new Request(`http://example.com/api/events/${CODE}/gallery`))
    ).json<{ items: unknown[] }>();
    expect(listed.items).toEqual([]);

    await call(
      new Request(`http://example.com/api/host/events/${EVENT_ID}/media/toggle`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden: false }),
      }),
    );
    listed = await (
      await call(new Request(`http://example.com/api/events/${CODE}/gallery`))
    ).json<{ items: unknown[] }>();
    expect(listed.items).toHaveLength(1);
  });

  it("delete removes R2 keys and the row", async () => {
    await seedReadyPhoto("gone");
    const del = await call(
      new Request(`http://example.com/api/host/events/${EVENT_ID}/media/gone`, {
        method: "DELETE",
      }),
    );
    expect(del.status).toBe(204);
    const row = await env.DB.prepare("SELECT id FROM media WHERE id='gone'").first();
    expect(row).toBeNull();
    expect(await env.PHOTOS.head(`events/${EVENT_ID}/web/gone.jpg`)).toBeNull();
  });
});

describe("GET /api/host/events/:id/zip", () => {
  it("streams a ZIP containing a ready photo", async () => {
    await seedReadyPhoto("z1");
    const res = await call(new Request(`http://example.com/api/host/events/${EVENT_ID}/zip`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes.length).toBeGreaterThan(100);
  });

  it("fetches Stream MP4 bytes for videos when download succeeds", async () => {
    const uid = "stream-uid-1";
    const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : "";
      if (url.includes(uid)) {
        return Promise.resolve(new Response(mp4, { status: 200 }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    await env.DB.prepare(
      `INSERT INTO media (id, event_id, kind, stream_uid, status, hidden, created_at)
       VALUES ('v1', ?, 'video', ?, 'ready', 0, datetime('now'))`,
    )
      .bind(EVENT_ID, uid)
      .run();

    const prevToken = env.STREAM_API_TOKEN;
    const prevAccount = env.R2_ACCOUNT_ID;
    env.STREAM_API_TOKEN = "token";
    env.R2_ACCOUNT_ID = "acc";
    try {
      const res = await call(new Request(`http://example.com/api/host/events/${EVENT_ID}/zip`));
      expect(res.status).toBe(200);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes[0]).toBe(0x50);
    } finally {
      env.STREAM_API_TOKEN = prevToken;
      env.R2_ACCOUNT_ID = prevAccount;
      vi.restoreAllMocks();
    }
  });
});
