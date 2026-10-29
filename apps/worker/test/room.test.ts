import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  announceMedia,
  audienceFor,
  buildEnvelope,
  parseEnvelope,
  serializeMessage,
} from "../src/lib/room";
import type { GalleryItemDto } from "../src/lib/gallery";
import { jpeg } from "./fixtures";

const EVENT_ID = "evt-room";
const CODE = "room123";

const item: GalleryItemDto = {
  id: "p1",
  kind: "photo",
  width: 4,
  height: 3,
  duration_s: null,
  taken_at: null,
  created_at: "2026-01-01 00:00:00",
  thumb_url: "/t",
  web_url: "/w",
  poster_url: null,
  hls_url: null,
};

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function open(path: string): Promise<{ ws: WebSocket; next: () => Promise<unknown> }> {
  const res = await call(
    new Request(`http://example.com${path}`, { headers: { upgrade: "websocket" } }),
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no websocket");
  const queue: unknown[] = [];
  let waiter: ((v: unknown) => void) | null = null;
  ws.addEventListener("message", (e) => {
    const data: unknown = JSON.parse(String(e.data));
    if (waiter) {
      waiter(data);
      waiter = null;
    } else queue.push(data);
  });
  ws.accept();
  return {
    ws,
    next: () =>
      queue.length > 0
        ? Promise.resolve(queue.shift())
        : new Promise((resolve) => {
            waiter = resolve;
          }),
  };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM media"),
    env.DB.prepare("DELETE FROM guests"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare(
      "INSERT INTO events (id, host_sub, name, join_code, reveal_mode, video_max_seconds) VALUES (?, 'dev-bypass', 'Room', ?, 'instant', 60)",
    ).bind(EVENT_ID, CODE),
  ]);
  await env.LINKS.put(CODE, EVENT_ID);
});

describe("broadcast payloads", () => {
  it("routes audiences by message type and reveal state", () => {
    expect(audienceFor({ type: "media.ready", item }, true)).toBe("all");
    expect(audienceFor({ type: "media.ready", item }, false)).toBe("host");
    expect(audienceFor({ type: "media.failed", id: "p1" }, true)).toBe("host");
    expect(audienceFor({ type: "media.hidden", id: "p1" }, false)).toBe("all");
    expect(audienceFor({ type: "media.deleted", id: "p1" }, false)).toBe("all");
  });

  it("serializes the message only, and round-trips envelopes", () => {
    const envelope = buildEnvelope({ type: "media.deleted", id: "p1" }, true);
    expect(serializeMessage(envelope.message)).toBe('{"type":"media.deleted","id":"p1"}');
    expect(parseEnvelope(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);
    expect(
      parseEnvelope({ audience: "x", message: { type: "media.deleted", id: "p1" } }),
    ).toBeNull();
    expect(parseEnvelope({ audience: "all", message: { type: "nope" } })).toBeNull();
    expect(parseEnvelope({ audience: "all", message: { type: "media.hidden" } })).toBeNull();
  });
});

describe("EventRoom websockets", () => {
  it("requires an upgrade and a known event", async () => {
    expect((await call(new Request(`http://example.com/api/events/${CODE}/live`))).status).toBe(
      426,
    );
    const missing = await call(
      new Request("http://example.com/api/events/nope1/live", {
        headers: { upgrade: "websocket" },
      }),
    );
    expect(missing.status).toBe(404);
  });

  it("fans out hide, unhide and delete from host moderation", async () => {
    const bytes = jpeg(40, 30);
    await env.PHOTOS.put("k", bytes);
    await env.DB.prepare(
      `INSERT INTO media (id, event_id, kind, r2_key, thumb_key, web_key, status, content_type, size_bytes)
       VALUES ('p1', ?, 'photo', 'k', 'k', 'k', 'ready', 'image/jpeg', ?)`,
    )
      .bind(EVENT_ID, bytes.length)
      .run();
    const guest = await open(`/api/events/${CODE}/live`);
    const host = await open(`/api/host/events/${EVENT_ID}/live`);

    const patch = (hidden: boolean) =>
      call(
        new Request(`http://example.com/api/host/events/${EVENT_ID}/media/p1`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hidden }),
        }),
      );
    expect((await patch(true)).status).toBe(200);
    expect(await guest.next()).toEqual({ type: "media.hidden", id: "p1" });
    expect(await host.next()).toEqual({ type: "media.hidden", id: "p1" });

    expect((await patch(false)).status).toBe(200);
    const shown = (await guest.next()) as { type: string; item: { id: string; thumb_url: string } };
    expect(shown.type).toBe("media.ready");
    expect(shown.item.thumb_url).toBe(`/api/events/${CODE}/media/p1/thumb`);
    await host.next();

    const del = await call(
      new Request(`http://example.com/api/host/events/${EVENT_ID}/media/p1`, { method: "DELETE" }),
    );
    expect(del.status).toBe(204);
    expect(await guest.next()).toEqual({ type: "media.deleted", id: "p1" });
    guest.ws.close();
    host.ws.close();
  });

  it("withholds unrevealed media from guests but not the host", async () => {
    await env.DB.prepare("UPDATE events SET reveal_mode='private' WHERE id=?").bind(EVENT_ID).run();
    await env.DB.prepare(
      `INSERT INTO media (id, event_id, kind, status) VALUES ('p2', ?, 'photo', 'ready')`,
    )
      .bind(EVENT_ID)
      .run();
    const guest = await open(`/api/events/${CODE}/live`);
    const host = await open(`/api/host/events/${EVENT_ID}/live`);
    await announceMedia(env, "p2");
    expect(((await host.next()) as { type: string }).type).toBe("media.ready");
    const stub = env.EVENT_ROOM.get(env.EVENT_ROOM.idFromName(EVENT_ID));
    await stub.fetch("https://room/broadcast", {
      method: "POST",
      body: JSON.stringify(buildEnvelope({ type: "media.deleted", id: "marker" }, true)),
    });
    expect(await guest.next()).toEqual({ type: "media.deleted", id: "marker" });
  });
});
