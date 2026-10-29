import { downloadZip } from "client-zip";
import { streamConfig, streamMp4DownloadUrl } from "./stream";
import { ZIP_MAX_BYTES, ZIP_MAX_FILES } from "./gallery";

type ZipRow = {
  id: string;
  kind: string;
  created_at: string;
  r2_key: string | null;
  web_key: string | null;
  stream_uid: string | null;
};

function zipName(row: ZipRow, ext: string): string {
  const stamp = row.created_at.replace(/[:.]/g, "-");
  return `${stamp}_${row.id.slice(0, 8)}.${ext}`;
}

function asByteStream(body: ReadableStream): ReadableStream<Uint8Array> {
  return body as ReadableStream<Uint8Array>;
}

async function photoEntry(
  bucket: R2Bucket,
  row: ZipRow,
): Promise<{ name: string; input: ReadableStream<Uint8Array> } | null> {
  const key = row.web_key ?? row.r2_key;
  if (!key) return null;
  const object = await bucket.get(key);
  if (!object?.body) return null;
  const ext = key.endsWith(".png") ? "png" : "jpg";
  return { name: zipName(row, ext), input: asByteStream(object.body) };
}

async function videoEntry(
  env: Cloudflare.Env,
  row: ZipRow,
): Promise<{ name: string; input: ReadableStream<Uint8Array> } | null> {
  if (!row.stream_uid) return null;
  const config = streamConfig(env);
  if (!config) return null;
  const url = streamMp4DownloadUrl(config.accountId, row.stream_uid);
  const res = await fetch(url);
  if (!res.ok || !res.body) return null;
  return { name: zipName(row, "mp4"), input: asByteStream(res.body) };
}

export type ZipBuildResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; error: string; limit?: number };

export async function buildEventZip(
  env: Cloudflare.Env,
  bucket: R2Bucket,
  eventName: string,
  rows: ZipRow[],
): Promise<ZipBuildResult> {
  if (rows.length === 0) {
    return { ok: false, status: 404, error: "no_media" };
  }
  if (rows.length > ZIP_MAX_FILES) {
    return { ok: false, status: 413, error: "zip_too_many_files", limit: ZIP_MAX_FILES };
  }

  let estimatedBytes = 0;
  const entries: { name: string; input: ReadableStream<Uint8Array> }[] = [];
  for (const row of rows) {
    const entry =
      row.kind === "video" ? await videoEntry(env, row) : await photoEntry(bucket, row);
    if (!entry) continue;
    entries.push(entry);
    estimatedBytes += 8 * 1024 * 1024;
    if (estimatedBytes > ZIP_MAX_BYTES) {
      return { ok: false, status: 413, error: "zip_too_large" };
    }
  }

  if (entries.length === 0) {
    return { ok: false, status: 404, error: "no_downloadable_media" };
  }

  const safeName = eventName.replace(/[^\w.-]+/g, "_").slice(0, 80) || "event";
  const zip = downloadZip(entries);
  return {
    ok: true,
    response: new Response(zip.body, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${safeName}.zip"`,
        "cache-control": "no-store",
      },
    }),
  };
}
