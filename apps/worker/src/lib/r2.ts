import { hmacSha256, sha256Hex, toHex } from "./crypto";

export type PresignOptions = {
  method: "GET" | "PUT";
  host: string;
  path: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresInSeconds: number;
  signedHeaders?: Record<string, string>;
  now?: Date;
};

function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodePath(path: string): string {
  return path.split("/").map(uriEncode).join("/");
}

function amzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export async function presignUrl(options: PresignOptions): Promise<string> {
  const now = options.now ?? new Date();
  const dateTime = amzDate(now);
  const date = dateTime.slice(0, 8);
  const scope = `${date}/${options.region}/${options.service}/aws4_request`;

  const headers = new Map<string, string>([["host", options.host]]);
  for (const [name, value] of Object.entries(options.signedHeaders ?? {})) {
    headers.set(name.toLowerCase(), value.trim());
  }
  const headerNames = [...headers.keys()].sort();
  const signedHeaders = headerNames.join(";");

  const query: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${options.accessKeyId}/${scope}`],
    ["X-Amz-Date", dateTime],
    ["X-Amz-Expires", String(options.expiresInSeconds)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ];
  const canonicalQuery = query
    .map(([k, v]): [string, string] => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalPath = encodePath(options.path);
  const canonicalRequest = [
    options.method,
    canonicalPath,
    canonicalQuery,
    ...headerNames.map((name) => `${name}:${headers.get(name) ?? ""}`),
    "",
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    dateTime,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmacSha256(`AWS4${options.secretAccessKey}`, date);
  const kRegion = await hmacSha256(kDate, options.region);
  const kService = await hmacSha256(kRegion, options.service);
  const kSigning = await hmacSha256(kService, "aws4_request");
  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  return `https://${options.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export type R2PresignConfig = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export function presignR2Put(
  config: R2PresignConfig,
  key: string,
  contentType: string,
  expiresInSeconds = 900,
  now?: Date,
): Promise<string> {
  return presignUrl({
    method: "PUT",
    host: `${config.accountId}.r2.cloudflarestorage.com`,
    path: `/${config.bucket}/${key}`,
    region: "auto",
    service: "s3",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    expiresInSeconds,
    signedHeaders: { "content-type": contentType },
    now,
  });
}
