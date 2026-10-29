import { MAX_ATTEMPTS, markFailed, processPhoto } from "./lib/process";
import type { PhotoQueueMessage } from "./types";

const RETRY_BASE_SECONDS = 10;

export async function handlePhotoQueueBatch(
  batch: MessageBatch<PhotoQueueMessage>,
  env: Cloudflare.Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processPhoto(env, message.body.mediaId);
      message.ack();
    } catch (error) {
      if (message.attempts >= MAX_ATTEMPTS) {
        await markFailed(env, message.body.mediaId, error);
        message.ack();
      } else {
        message.retry({ delaySeconds: RETRY_BASE_SECONDS * 2 ** (message.attempts - 1) });
      }
    }
  }
}
