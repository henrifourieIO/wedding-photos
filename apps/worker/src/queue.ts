import type { PhotoQueueMessage } from "./types";

export function handlePhotoQueueBatch(
  batch: MessageBatch<PhotoQueueMessage>,
  env: Cloudflare.Env,
): void {
  for (const message of batch.messages) {
    const body = message.body;
    console.log("photo-uploaded stub", {
      mediaId: body.mediaId,
      eventId: body.eventId,
      hasStreamSecret: env.STREAM_WEBHOOK_SECRET !== undefined,
    });
    message.ack();
  }
}
