import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, putWithProgress } from "./api";
import { prepareImage } from "./image";
import { inferVideoType, isVideoFile, uploadToStream } from "./video";

export type UploadStatus = "queued" | "preparing" | "uploading" | "finalizing" | "done" | "error";

export type UploadItem = {
  id: string;
  name: string;
  status: UploadStatus;
  progress: number;
  attempts: number;
  error?: string;
  previewUrl: string;
  kind: "photo" | "video";
};

const CONCURRENCY = 3;
const MAX_AUTO_ATTEMPTS = 3;

function isActive(status: UploadStatus): boolean {
  return status === "preparing" || status === "uploading" || status === "finalizing";
}

function describeError(err: unknown): { message: string; retryable: boolean } {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "rate_limited":
        return { message: "Slow down a little, then retry", retryable: true };
      case "unauthorized":
        return { message: "Session expired, reload and rejoin", retryable: false };
      case "too_large":
        return { message: "File is too large", retryable: false };
      case "unsupported_content_type":
        return { message: "Unsupported file format", retryable: false };
      case "stream_not_configured":
        return { message: "Video uploads are not available", retryable: false };
      default:
        return { message: "Upload failed", retryable: true };
    }
  }
  if (err instanceof Error && err.message === "unsupported_type") {
    return { message: "Unsupported file format", retryable: false };
  }
  return { message: "Upload failed", retryable: true };
}

export function useUploadQueue(code: string, onUploaded: () => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const files = useRef(new Map<string, Blob & { name?: string }>());
  const started = useRef(new Set<string>());
  const onUploadedRef = useRef(onUploaded);
  useEffect(() => {
    onUploadedRef.current = onUploaded;
  }, [onUploaded]);

  const patch = useCallback((id: string, change: Partial<UploadItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...change } : item)));
  }, []);

  const run = useCallback(
    async (id: string) => {
      const file = files.current.get(id);
      if (!file) return;
      try {
        if (isVideoFile(file)) {
          const contentType = inferVideoType(file);
          if (!contentType) throw new Error("unsupported_type");
          const ticket = await api.createVideoUpload(code, contentType, file.size);
          patch(id, { status: "uploading", progress: 0 });
          await uploadToStream(ticket, file, file.name ?? "video", (fraction) => {
            patch(id, { progress: fraction });
          });
          files.current.delete(id);
          patch(id, { status: "done", progress: 1 });
          onUploadedRef.current();
          return;
        }
        const prepared = await prepareImage(file);
        const ticket = await api.createUpload(code, prepared.contentType, prepared.blob.size);
        patch(id, { status: "uploading", progress: 0 });
        await putWithProgress(ticket.upload, prepared.blob, (fraction) => {
          patch(id, { progress: fraction });
        });
        patch(id, { status: "finalizing", progress: 1 });
        await api.completeUpload(code, ticket.id);
        files.current.delete(id);
        patch(id, { status: "done", progress: 1 });
        onUploadedRef.current();
      } catch (err) {
        const { message, retryable } = describeError(err);
        setItems((prev) =>
          prev.map((item) => {
            if (item.id !== id) return item;
            const attempts = item.attempts + 1;
            const willRetry = retryable && attempts < MAX_AUTO_ATTEMPTS;
            if (willRetry) {
              window.setTimeout(
                () => {
                  started.current.delete(id);
                  patch(id, { status: "queued" });
                },
                1500 * 2 ** attempts,
              );
            }
            return { ...item, attempts, status: "error", error: willRetry ? "Retrying…" : message };
          }),
        );
      }
    },
    [code, patch],
  );

  useEffect(() => {
    const active = items.filter((item) => isActive(item.status)).length;
    const slots = CONCURRENCY - active;
    if (slots <= 0) return;
    const next = items
      .filter((item) => item.status === "queued" && !started.current.has(item.id))
      .slice(0, slots);
    for (const item of next) {
      started.current.add(item.id);
      patch(item.id, { status: "preparing", error: undefined });
      void run(item.id);
    }
  }, [items, patch, run]);

  useEffect(() => {
    const urls = files.current;
    return () => {
      urls.clear();
    };
  }, []);

  const enqueue = useCallback((selected: (Blob & { name?: string })[]) => {
    const added: UploadItem[] = selected.map((file) => {
      const id = crypto.randomUUID();
      files.current.set(id, file);
      return {
        id,
        name: file.name ?? (isVideoFile(file) ? "video" : "photo"),
        status: "queued",
        progress: 0,
        attempts: 0,
        previewUrl: URL.createObjectURL(file),
        kind: isVideoFile(file) ? "video" : "photo",
      };
    });
    setItems((prev) => [...added, ...prev]);
  }, []);

  const retry = useCallback(
    (id: string) => {
      started.current.delete(id);
      patch(id, { status: "queued", attempts: 0, error: undefined });
    },
    [patch],
  );

  const dismiss = useCallback((id: string) => {
    setItems((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
    files.current.delete(id);
  }, []);

  return { items, enqueue, retry, dismiss };
}
