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
  if (
    !env.R2_ACCOUNT_ID ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY ||
    !env.R2_BUCKET_NAME
  ) {
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

export class CoverPresignUnavailableError extends Error {
  constructor() {
    super("cover_presign_unavailable");
    this.name = "CoverPresignUnavailableError";
  }
}

export function coverPresignUnavailableResponse(): {
  error: string;
  reason: string;
  hint: string;
} {
  return {
    error: "cover_presign_unavailable",
    reason:
      "R2 S3 API credentials are not configured on the Worker, so cover photo presigned uploads are unavailable.",
    hint:
      "Create an R2 S3 API token (Object Read & Write, scoped to the wedding-photos bucket), then set production secrets R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY. Add a bucket CORS rule allowing PUT from your workers.dev origin. See README.",
  };
}
