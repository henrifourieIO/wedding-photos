import { presignR2Put, type R2PresignConfig } from "./r2";

export function coverObjectKey(eventId: string, extension: string): string {
  const safeExt = extension.replace(/^\./, "").toLowerCase() || "jpg";
  return `covers/${eventId}/cover.${safeExt}`;
}

export function extensionFromContentType(contentType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  return map[contentType.toLowerCase()] ?? "jpg";
}

export function r2PresignConfig(env: Cloudflare.Env): R2PresignConfig | null {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) {
    return null;
  }
  return {
    accountId: env.R2_ACCOUNT_ID,
    bucket: env.R2_BUCKET_NAME,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
}

export async function presignCoverPut(
  env: Cloudflare.Env,
  key: string,
  contentType: string,
): Promise<string | null> {
  const config = r2PresignConfig(env);
  if (!config) {
    return null;
  }
  return presignR2Put(config, key, contentType);
}
