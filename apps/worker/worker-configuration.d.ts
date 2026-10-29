/* eslint-disable */
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    PHOTOS: R2Bucket;
    LINKS: KVNamespace;
    PHOTO_QUEUE: Queue<PhotoQueueMessage>;
    EVENT_ROOM: DurableObjectNamespace<EventRoom>;
    ASSETS: Fetcher;
    GUEST_COOKIE_SECRET: string;
    R2_ACCOUNT_ID?: string;
    R2_ACCESS_KEY_ID?: string;
    R2_SECRET_ACCESS_KEY?: string;
    R2_BUCKET_NAME?: string;
    MAX_UPLOAD_BYTES?: string;
    MAX_VIDEO_BYTES?: string;
    STREAM_ACCOUNT_ID?: string;
    STREAM_API_TOKEN?: string;
    STREAM_WEBHOOK_SECRET?: string;
    CF_ACCESS_TEAM_DOMAIN?: string;
    CF_ACCESS_AUD?: string;
    DEV_BYPASS_ACCESS?: string;
    ENVIRONMENT?: string;
  }
}

interface PhotoQueueMessage {
  mediaId: string;
  eventId: string;
}

interface EventRoom extends DurableObject {}

declare const env: Cloudflare.Env;
