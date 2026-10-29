import { deleteStreamVideo, streamConfig } from "./stream";

type MediaKeys = {
  kind: string;
  r2_key: string | null;
  thumb_key: string | null;
  web_key: string | null;
  stream_uid: string | null;
};

export async function deleteMediaObjects(
  env: Cloudflare.Env,
  bucket: R2Bucket,
  row: MediaKeys,
): Promise<void> {
  const keys = [row.r2_key, row.thumb_key, row.web_key].filter(
    (k): k is string => typeof k === "string" && k.length > 0,
  );
  await Promise.all(keys.map((key) => bucket.delete(key)));
  if (row.kind === "video" && row.stream_uid) {
    const config = streamConfig(env);
    if (config) await deleteStreamVideo(config, row.stream_uid);
  }
}
