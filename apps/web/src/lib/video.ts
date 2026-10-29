import { ApiError } from "./api";

export type VideoTicket = {
  uploadUrl: string;
  mediaId: string;
  protocol: "basic" | "tus";
  maxDurationSeconds: number;
};

const TUS_CHUNK_BYTES = 48 * 1024 * 1024;
const TUS_RETRIES = 4;
const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];

export function inferVideoType(file: Blob & { name?: string }): string | null {
  const type = file.type.toLowerCase().split(";")[0]?.trim() ?? "";
  if (VIDEO_TYPES.includes(type)) return type;
  const ext = file.name?.split(".").pop()?.toLowerCase();
  if (ext === "mp4" || ext === "m4v") return "video/mp4";
  if (ext === "mov") return "video/quicktime";
  if (ext === "webm") return "video/webm";
  return null;
}

export function isVideoFile(file: Blob & { name?: string }): boolean {
  return file.type.startsWith("video/") || inferVideoType(file) !== null;
}

function xhrSend(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Blob | FormData | null,
  onProgress?: (loaded: number) => void,
): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr);
      else reject(new ApiError(xhr.status, "upload_failed"));
    };
    xhr.onerror = () => {
      reject(new ApiError(0, "network"));
    };
    xhr.ontimeout = () => {
      reject(new ApiError(0, "network"));
    };
    xhr.send(body);
  });
}

async function uploadBasic(
  url: string,
  blob: Blob,
  name: string,
  onProgress: (fraction: number) => void,
): Promise<void> {
  const form = new FormData();
  form.append("file", blob, name);
  await xhrSend("POST", url, {}, form, (loaded) => {
    onProgress(Math.min(1, loaded / blob.size));
  });
}

async function tusOffset(url: string): Promise<number> {
  const xhr = await xhrSend("HEAD", url, { "Tus-Resumable": "1.0.0" }, null);
  return Number.parseInt(xhr.getResponseHeader("Upload-Offset") ?? "0", 10) || 0;
}

async function uploadTus(
  url: string,
  blob: Blob,
  onProgress: (fraction: number) => void,
): Promise<void> {
  let offset = 0;
  let failures = 0;
  while (offset < blob.size) {
    const chunk = blob.slice(offset, Math.min(offset + TUS_CHUNK_BYTES, blob.size));
    const base = offset;
    try {
      const xhr = await xhrSend(
        "PATCH",
        url,
        {
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": String(base),
          "Content-Type": "application/offset+octet-stream",
        },
        chunk,
        (loaded) => {
          onProgress((base + loaded) / blob.size);
        },
      );
      const reported = Number.parseInt(xhr.getResponseHeader("Upload-Offset") ?? "", 10);
      offset = Number.isFinite(reported) ? reported : base + chunk.size;
      failures = 0;
    } catch (err) {
      failures += 1;
      if (failures > TUS_RETRIES || (err instanceof ApiError && err.status >= 400)) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** failures));
      offset = await tusOffset(url).catch(() => base);
    }
  }
  onProgress(1);
}

export function uploadToStream(
  ticket: VideoTicket,
  blob: Blob,
  name: string,
  onProgress: (fraction: number) => void,
): Promise<void> {
  switch (ticket.protocol) {
    case "basic":
      return uploadBasic(ticket.uploadUrl, blob, name, onProgress);
    case "tus":
      return uploadTus(ticket.uploadUrl, blob, onProgress);
    default: {
      const unreachable: never = ticket.protocol;
      return Promise.reject(new Error(String(unreachable)));
    }
  }
}

export const canRecord =
  typeof navigator !== "undefined" &&
  "mediaDevices" in navigator &&
  typeof MediaRecorder !== "undefined";
