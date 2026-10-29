export const TUS_THRESHOLD_BYTES = 200 * 1024 * 1024;
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const API_BASE = "https://api.cloudflare.com/client/v4";

export type StreamConfig = { accountId: string; apiToken: string };

export type StreamMeta = { event_id: string; media_id: string; guest_id: string };

export type StreamUpload = { uploadUrl: string; uid: string; protocol: "basic" | "tus" };

export class StreamError extends Error {
  constructor(readonly status: number) {
    super(`stream_api_${String(status)}`);
  }
}

export function streamConfig(env: Cloudflare.Env): StreamConfig | null {
  const accountId = env.STREAM_ACCOUNT_ID ?? env.R2_ACCOUNT_ID;
  if (!accountId || !env.STREAM_API_TOKEN) return null;
  return { accountId, apiToken: env.STREAM_API_TOKEN };
}

export function base64(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

async function createBasicUpload(
  config: StreamConfig,
  maxDurationSeconds: number,
  meta: StreamMeta,
): Promise<StreamUpload> {
  const res = await fetch(`${API_BASE}/accounts/${config.accountId}/stream/direct_upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({ maxDurationSeconds, requireSignedURLs: false, meta }),
  });
  if (!res.ok) throw new StreamError(res.status);
  const body = await res.json<{ result?: { uploadURL?: string; uid?: string } }>();
  const uploadUrl = body.result?.uploadURL;
  const uid = body.result?.uid;
  if (!uploadUrl || !uid) throw new StreamError(502);
  return { uploadUrl, uid, protocol: "basic" };
}

async function createTusUpload(
  config: StreamConfig,
  size: number,
  maxDurationSeconds: number,
  meta: StreamMeta,
): Promise<StreamUpload> {
  const metadata = [
    `maxDurationSeconds ${base64(String(maxDurationSeconds))}`,
    `name ${base64(`${meta.event_id}/${meta.media_id}`)}`,
  ].join(",");
  const res = await fetch(`${API_BASE}/accounts/${config.accountId}/stream?direct_user=true`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiToken}`,
      "tus-resumable": "1.0.0",
      "upload-length": String(size),
      "upload-metadata": metadata,
      "upload-creator": meta.guest_id,
    },
  });
  if (!res.ok) throw new StreamError(res.status);
  const uploadUrl = res.headers.get("location");
  const uid = res.headers.get("stream-media-id");
  if (!uploadUrl || !uid) throw new StreamError(502);
  return { uploadUrl, uid, protocol: "tus" };
}

export function createDirectUpload(
  config: StreamConfig,
  params: { size: number; maxDurationSeconds: number; meta: StreamMeta },
): Promise<StreamUpload> {
  return params.size > TUS_THRESHOLD_BYTES
    ? createTusUpload(config, params.size, params.maxDurationSeconds, params.meta)
    : createBasicUpload(config, params.maxDurationSeconds, params.meta);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signWebhook(secret: string, time: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${String(time)}.${body}`)),
  );
}

export type SignatureResult = "valid" | "malformed" | "stale" | "mismatch";

export async function verifyWebhookSignature(
  secret: string,
  header: string | null | undefined,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<SignatureResult> {
  if (!header) return "malformed";
  let time = "";
  let sig = "";
  for (const part of header.split(",")) {
    const [name, value] = part.trim().split("=");
    if (name === "time") time = value ?? "";
    if (name === "sig1") sig = value ?? "";
  }
  const timestamp = Number.parseInt(time, 10);
  if (!Number.isFinite(timestamp) || !/^[0-9a-f]{64}$/.test(sig)) return "malformed";
  if (Math.abs(nowSeconds - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return "stale";
  const expected = await signWebhook(secret, timestamp, body);
  return timingSafeEqual(expected, sig) ? "valid" : "mismatch";
}

export type StreamWebhookPayload = {
  uid?: string;
  readyToStream?: boolean;
  status?: { state?: string; errorReasonCode?: string };
  thumbnail?: string;
  duration?: number;
  playback?: { hls?: string; dash?: string };
};

export type StreamOutcome =
  | {
      type: "ready";
      durationS: number | null;
      posterUrl: string | null;
      hlsUrl: string | null;
      dashUrl: string | null;
    }
  | { type: "failed" }
  | { type: "ignore" };

export function streamMp4DownloadUrl(_accountId: string, uid: string): string {
  return `https://videodelivery.net/${uid}/downloads/default.mp4`;
}

export async function deleteStreamVideo(config: StreamConfig, uid: string): Promise<void> {
  const res = await fetch(`${API_BASE}/accounts/${config.accountId}/stream/${uid}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${config.apiToken}` },
  });
  if (!res.ok && res.status !== 404) throw new StreamError(res.status);
}

export function classifyWebhook(payload: StreamWebhookPayload): StreamOutcome {
  if (payload.status?.state === "error") return { type: "failed" };
  if (payload.readyToStream === true) {
    const duration = payload.duration;
    return {
      type: "ready",
      durationS: typeof duration === "number" && duration >= 0 ? duration : null,
      posterUrl: payload.thumbnail ?? null,
      hlsUrl: payload.playback?.hls ?? null,
      dashUrl: payload.playback?.dash ?? null,
    };
  }
  return { type: "ignore" };
}
