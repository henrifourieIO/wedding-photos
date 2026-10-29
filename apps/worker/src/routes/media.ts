import { Hono } from "hono";
import type { Context } from "hono";
import { isGalleryVisible, resolveEvent, type EventRow } from "../lib/events";
import { authenticateGuest, type GuestRow } from "../lib/guest";
import { assertNever, type PhotoQueueMessage } from "../types";

type Ctx = Context<{ Bindings: Cloudflare.Env }>;

type MediaRow = {
  id: string;
  guest_id: string | null;
  kind: string;
  status: string;
  hidden: number;
  r2_key: string | null;
  thumb_key: string | null;
  web_key: string | null;
  content_type: string | null;
};

type Variant = "thumb" | "web" | "orig";

const NOT_FOUND = { error: "not_found" } as const;

export const media = new Hono<{ Bindings: Cloudflare.Env }>();

function parseVariant(value: string): Variant | null {
  return value === "thumb" || value === "web" || value === "orig" ? value : null;
}

function variantKey(row: MediaRow, variant: Variant): string | null {
  switch (variant) {
    case "thumb":
      return row.thumb_key;
    case "web":
      return row.web_key;
    case "orig":
      return row.r2_key;
    default:
      return assertNever(variant);
  }
}

async function optionalGuest(c: Ctx, event: EventRow): Promise<GuestRow | null> {
  return authenticateGuest(c, event.join_code, event.id);
}

media.get("/events/:code/media/:id/:variant", async (c) => {
  const event = await resolveEvent(c.env, c.req.param("code"));
  const variant = parseVariant(c.req.param("variant"));
  if (!event || !variant) return c.json(NOT_FOUND, 404);
  const row = await c.env.DB.prepare(
    `SELECT id, guest_id, kind, status, hidden, r2_key, thumb_key, web_key, content_type
     FROM media WHERE id = ? AND event_id = ? AND kind = 'photo'`,
  )
    .bind(c.req.param("id"), event.id)
    .first<MediaRow>();
  if (!row) return c.json(NOT_FOUND, 404);

  const me = await optionalGuest(c, event);
  const owner = me !== null && row.guest_id === me.id;
  const publicVisible = row.status === "ready" && row.hidden === 0 && isGalleryVisible(event);
  if (variant === "orig" ? !owner : !owner && !publicVisible) return c.json(NOT_FOUND, 404);

  const key = variantKey(row, variant);
  if (!key) return c.json(NOT_FOUND, 404);
  const object = await c.env.PHOTOS.get(key);
  if (!object) return c.json(NOT_FOUND, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set(
    "cache-control",
    publicVisible && variant !== "orig"
      ? "public, max-age=31536000, immutable"
      : "private, max-age=300",
  );
  headers.set("x-content-type-options", "nosniff");
  if (variant === "orig" && row.content_type) headers.set("content-type", row.content_type);
  return new Response(object.body, { headers });
});

media.post("/events/:code/uploads/:id/reprocess", async (c) => {
  const event = await resolveEvent(c.env, c.req.param("code"));
  if (!event) return c.json(NOT_FOUND, 404);
  const me = await optionalGuest(c, event);
  if (!me) return c.json({ error: "unauthorized" }, 401);
  const row = await c.env.DB.prepare(
    "SELECT id, status FROM media WHERE id = ? AND event_id = ? AND guest_id = ? AND kind = 'photo'",
  )
    .bind(c.req.param("id"), event.id, me.id)
    .first<{ id: string; status: string }>();
  if (!row) return c.json(NOT_FOUND, 404);
  if (row.status === "pending") return c.json({ error: "not_uploaded" }, 409);

  await c.env.DB.prepare(
    "UPDATE media SET status = 'uploaded', reason = NULL, error = NULL, processed_at = NULL WHERE id = ?",
  )
    .bind(row.id)
    .run();
  const message: PhotoQueueMessage = { mediaId: row.id, eventId: event.id };
  await c.env.PHOTO_QUEUE.send(message);
  return c.json({ id: row.id, status: "uploaded" }, 202);
});
