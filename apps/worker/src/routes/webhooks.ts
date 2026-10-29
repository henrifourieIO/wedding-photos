import { Hono } from "hono";
import {
  classifyWebhook,
  verifyWebhookSignature,
  type StreamOutcome,
  type StreamWebhookPayload,
} from "../lib/stream";
import { announceMedia } from "../lib/room";
import { assertNever } from "../types";

export const webhooks = new Hono<{ Bindings: Cloudflare.Env }>();

async function applyOutcome(db: D1Database, uid: string, outcome: StreamOutcome): Promise<number> {
  switch (outcome.type) {
    case "ready": {
      const result = await db
        .prepare(
          `UPDATE media SET status = 'ready', duration_s = ?, poster_url = ?, hls_url = ?, dash_url = ?
           WHERE stream_uid = ? AND kind = 'video' AND status IN ('pending', 'failed')`,
        )
        .bind(outcome.durationS, outcome.posterUrl, outcome.hlsUrl, outcome.dashUrl, uid)
        .run();
      return result.meta.changes;
    }
    case "failed": {
      const result = await db
        .prepare(
          "UPDATE media SET status = 'failed' WHERE stream_uid = ? AND kind = 'video' AND status = 'pending'",
        )
        .bind(uid)
        .run();
      return result.meta.changes;
    }
    case "ignore":
      return 0;
    default:
      return assertNever(outcome);
  }
}

webhooks.post("/webhooks/stream", async (c) => {
  const secret = c.env.STREAM_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "not_configured" }, 503);
  const body = await c.req.text();
  const verdict = await verifyWebhookSignature(secret, c.req.header("webhook-signature"), body);
  if (verdict !== "valid") return c.json({ error: "invalid_signature" }, 401);

  let payload: StreamWebhookPayload;
  try {
    payload = JSON.parse(body) as StreamWebhookPayload;
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  if (!payload.uid) return c.json({ error: "invalid_body" }, 400);

  const changes = await applyOutcome(c.env.DB, payload.uid, classifyWebhook(payload));
  if (changes > 0) {
    const row = await c.env.DB.prepare("SELECT id FROM media WHERE stream_uid = ?")
      .bind(payload.uid)
      .first<{ id: string }>();
    if (row) await announceMedia(c.env, row.id);
  }
  return c.json({ ok: true, updated: changes > 0 });
});
