import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { handlePhotoQueueBatch } from "../src/queue";
import { MAX_ATTEMPTS, processPhoto } from "../src/lib/process";
import type { PhotoQueueMessage } from "../src/types";
import { dims, hasExifSegment, jpeg, png, withExif } from "./fixtures";

const EVENT_ID = "evt-p";
const CODE = "procode";

type Row = {
  status: string;
  reason: string | null;
  error: string | null;
  width: number | null;
  height: number | null;
  taken_at: string | null;
  processed_at: string | null;
  thumb_key: string | null;
  web_key: string | null;
};

async function seed(
  id: string,
  bytes: Uint8Array,
  contentType: string,
  opts: { guest?: string; status?: string } = {},
): Promise<void> {
  const key = `events/${EVENT_ID}/orig/${id}.bin`;
  await env.PHOTOS.put(key, bytes);
  await env.DB.prepare(
    `INSERT INTO media (id, event_id, guest_id, kind, r2_key, status, content_type, size_bytes)
     VALUES (?, ?, ?, 'photo', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      EVENT_ID,
      opts.guest ?? null,
      key,
      opts.status ?? "uploaded",
      contentType,
      bytes.length,
    )
    .run();
}

async function row(id: string): Promise<Row> {
  const r = await env.DB.prepare(
    "SELECT status, reason, error, width, height, taken_at, processed_at, thumb_key, web_key FROM media WHERE id = ?",
  )
    .bind(id)
    .first<Row>();
  if (!r) throw new Error("row missing");
  return r;
}

async function fetchObject(key: string | null): Promise<Uint8Array> {
  const obj = await env.PHOTOS.get(key ?? "missing");
  if (!obj) throw new Error("object missing");
  return new Uint8Array(await obj.arrayBuffer());
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM media"),
    env.DB.prepare("DELETE FROM guests"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare(
      "INSERT INTO events (id, host_sub, name, join_code, reveal_mode) VALUES (?, 'h', 'W', ?, 'instant')",
    ).bind(EVENT_ID, CODE),
  ]);
  await env.LINKS.put(CODE, EVENT_ID);
});

describe("processPhoto", () => {
  it("processes a JPEG: derivatives, EXIF stripped, metadata stored", async () => {
    const source = withExif(jpeg(3000, 2000), { orientation: 6, takenAt: "2025:06:14 16:30:05" });
    expect(hasExifSegment(source)).toBe(true);
    await seed("j1", source, "image/jpeg");

    expect(await processPhoto(env, "j1")).toBe("ready");
    const r = await row("j1");
    expect(r.status).toBe("ready");
    expect(r.width).toBe(2000);
    expect(r.height).toBe(3000);
    expect(r.taken_at).toBe("2025-06-14T16:30:05");
    expect(r.processed_at).not.toBeNull();

    const thumb = await fetchObject(`events/${EVENT_ID}/thumb/j1.jpg`);
    const web = await fetchObject(`events/${EVENT_ID}/web/j1.jpg`);
    expect(hasExifSegment(thumb)).toBe(false);
    expect(hasExifSegment(web)).toBe(false);
    expect(dims(thumb)).toEqual({ width: 267, height: 400 });
    expect(dims(web)).toEqual({ width: 1333, height: 2000 });
  });

  it("processes a PNG and does not upscale small images", async () => {
    await seed("p1", png(300, 200), "image/png");
    expect(await processPhoto(env, "p1")).toBe("ready");
    const r = await row("p1");
    expect([r.width, r.height]).toEqual([300, 200]);
    expect(dims(await fetchObject(r.web_key))).toEqual({ width: 300, height: 200 });
    expect(dims(await fetchObject(r.thumb_key))).toEqual({ width: 300, height: 200 });
  });

  it("rejects a content-type mismatch", async () => {
    await seed("m1", png(50, 50), "image/jpeg");
    expect(await processPhoto(env, "m1")).toBe("rejected");
    const r = await row("m1");
    expect(r).toMatchObject({ status: "rejected", reason: "content_type_mismatch", web_key: null });
  });

  it("rejects non-images and corrupt images", async () => {
    await seed("t1", new TextEncoder().encode("<html>hello</html>"), "image/jpeg");
    await seed("c1", jpeg(100, 100).subarray(0, 700), "image/jpeg");
    expect(await processPhoto(env, "t1")).toBe("rejected");
    expect((await row("t1")).reason).toBe("unrecognized_image");
    expect(await processPhoto(env, "c1")).toBe("rejected");
    expect((await row("c1")).reason).toBe("decode_failed");
  });

  it("marks HEIC ready without derivatives", async () => {
    const heic = new Uint8Array(64);
    heic.set(new TextEncoder().encode("ftypheic"), 4);
    await seed("h1", heic, "image/heic");
    expect(await processPhoto(env, "h1")).toBe("ready");
    expect(await row("h1")).toMatchObject({
      status: "ready",
      reason: "no_derivative_heic",
      web_key: null,
      thumb_key: null,
    });
  });

  it("is idempotent", async () => {
    await seed("i1", jpeg(800, 600), "image/jpeg");
    expect(await processPhoto(env, "i1")).toBe("ready");
    const first = await row("i1");
    const thumbBefore = await fetchObject(first.thumb_key);
    expect(await processPhoto(env, "i1")).toBe("skipped");
    expect(await row("i1")).toEqual(first);
    expect(await fetchObject(first.thumb_key)).toEqual(thumbBefore);

    await env.DB.prepare("UPDATE media SET status = 'processing' WHERE id = 'i1'").run();
    expect(await processPhoto(env, "i1")).toBe("ready");
    expect(await fetchObject(first.thumb_key)).toEqual(thumbBefore);
  });
});

describe("queue consumer", () => {
  function message(id: string, attempts: number) {
    return {
      body: { mediaId: id, eventId: EVENT_ID } satisfies PhotoQueueMessage,
      attempts,
      ack: vi.fn(),
      retry: vi.fn(),
    };
  }
  function batch(messages: ReturnType<typeof message>[]): MessageBatch<PhotoQueueMessage> {
    return {
      messages,
      queue: "q",
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<PhotoQueueMessage>;
  }

  it("acks processed messages and retries transient failures, then fails after max attempts", async () => {
    await seed("q1", jpeg(200, 100), "image/jpeg");
    await env.DB.prepare(
      "INSERT INTO media (id, event_id, kind, r2_key, status, content_type) VALUES ('q2', ?, 'photo', 'nope', 'uploaded', 'image/jpeg')",
    )
      .bind(EVENT_ID)
      .run();
    const ok = message("q1", 1);
    const missing = message("q2", 1);
    await handlePhotoQueueBatch(batch([ok, missing]), env);
    expect(ok.ack).toHaveBeenCalled();
    expect((await row("q1")).status).toBe("ready");
    expect(missing.ack).not.toHaveBeenCalled();
    expect(missing.retry).toHaveBeenCalledWith({ delaySeconds: 10 });

    const last = message("q2", MAX_ATTEMPTS);
    await handlePhotoQueueBatch(batch([last]), env);
    expect(last.ack).toHaveBeenCalled();
    expect(await row("q2")).toMatchObject({ status: "failed", error: "original missing from R2" });
  });

  it("acks messages for unknown media", async () => {
    const m = message("ghost", 1);
    await handlePhotoQueueBatch(batch([m]), env);
    expect(m.ack).toHaveBeenCalled();
  });
});

describe("media routes", () => {
  async function call(request: Request): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  async function join(name: string): Promise<{ cookie: string; id: string }> {
    const res = await call(
      new Request(`http://x.test/api/events/${CODE}/guests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ display_name: name }),
      }),
    );
    const body = await res.json<{ id: string }>();
    return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "", id: body.id };
  }
  async function get(path: string, cookie?: string): Promise<Response> {
    const res = await call(
      new Request(`http://x.test/api/events/${CODE}/media/${path}`, {
        headers: cookie ? { cookie } : {},
      }),
    );
    return new Response(await res.arrayBuffer(), res);
  }

  it("enforces visibility rules", async () => {
    const owner = await join("Owner");
    const other = await join("Other");
    await seed("v1", jpeg(500, 400), "image/jpeg", { guest: owner.id });
    await seed("v2", jpeg(500, 400), "image/jpeg", { guest: owner.id });
    await processPhoto(env, "v1");
    await processPhoto(env, "v2");
    await env.DB.prepare("UPDATE media SET hidden = 1 WHERE id = 'v2'").run();

    const pub = await get("v1/thumb");
    expect(pub.status).toBe(200);
    expect(pub.headers.get("content-type")).toBe("image/jpeg");
    expect(pub.headers.get("cache-control")).toContain("immutable");
    expect(hasExifSegment(new Uint8Array(await pub.arrayBuffer()))).toBe(false);

    expect((await get("v1/web", other.cookie)).status).toBe(200);
    expect((await get("v1/orig", other.cookie)).status).toBe(404);
    expect((await get("v1/orig")).status).toBe(404);
    expect((await get("v1/orig", owner.cookie)).status).toBe(200);
    expect((await get("v1/bogus")).status).toBe(404);

    expect((await get("v2/thumb", other.cookie)).status).toBe(404);
    const own = await get("v2/thumb", owner.cookie);
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toContain("private");

    await env.DB.prepare("UPDATE events SET reveal_mode = 'private'").run();
    expect((await get("v1/thumb", other.cookie)).status).toBe(404);
    expect((await get("v1/thumb", owner.cookie)).status).toBe(200);
  });

  it("hides unprocessed media from non-owners", async () => {
    const owner = await join("Owner");
    const other = await join("Other");
    await seed("u1", jpeg(100, 100), "image/jpeg", { guest: owner.id });
    expect((await get("u1/thumb", other.cookie)).status).toBe(404);
  });

  it("reprocess re-enqueues for the owner only", async () => {
    const owner = await join("Owner");
    const other = await join("Other");
    await seed("r1", jpeg(100, 100), "image/jpeg", { guest: owner.id, status: "failed" });
    await seed("r2", jpeg(100, 100), "image/jpeg", { guest: owner.id, status: "pending" });
    const post = (id: string, cookie?: string) =>
      call(
        new Request(`http://x.test/api/events/${CODE}/uploads/${id}/reprocess`, {
          method: "POST",
          headers: cookie ? { cookie } : {},
        }),
      );

    expect((await post("r1")).status).toBe(401);
    expect((await post("r1", other.cookie)).status).toBe(404);
    expect((await post("r2", owner.cookie)).status).toBe(409);
    const res = await post("r1", owner.cookie);
    expect(res.status).toBe(202);
    expect((await row("r1")).status).toBe("uploaded");
    expect(await processPhoto(env, "r1")).toBe("ready");
  });
});
