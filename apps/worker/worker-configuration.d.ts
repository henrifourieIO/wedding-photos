/* eslint-disable */
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    PHOTOS: R2Bucket;
    LINKS: KVNamespace;
    PHOTO_QUEUE: Queue<PhotoQueueMessage>;
    EVENT_ROOM: DurableObjectNamespace<EventRoom>;
    ASSETS: Fetcher;
    STREAM_API_TOKEN?: string;
    STREAM_WEBHOOK_SECRET?: string;
  }
}

interface PhotoQueueMessage {
  mediaId: string;
  eventId: string;
}

interface EventRoom extends DurableObject {}

declare const env: Cloudflare.Env;
