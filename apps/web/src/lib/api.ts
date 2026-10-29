export type EventInfo = {
  name: string;
  cover_url: string | null;
  reveal_mode: "instant" | "delayed" | "private";
  gallery_visible: boolean;
  video_max_seconds: number;
};

export type MediaStatus = "pending" | "uploaded" | "ready" | "rejected";

export type MyMedia = {
  id: string;
  kind: string;
  status: MediaStatus;
  size_bytes: number | null;
  created_at: string;
};

export type UploadTicket = {
  id: string;
  mode: "presigned" | "proxy";
  upload: { method: "PUT"; url: string; headers: Record<string, string> };
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? "request_failed");
  }
  return (await res.json()) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const base = (code: string) => `/api/events/${encodeURIComponent(code)}`;

export const api = {
  getEvent: (code: string) => request<EventInfo>(base(code)),
  getMe: (code: string) => request<{ id: string; display_name: string }>(`${base(code)}/me`),
  join: (code: string, displayName: string) =>
    post<{ id: string; display_name: string }>(`${base(code)}/guests`, {
      display_name: displayName,
    }),
  createUpload: (code: string, contentType: string, size: number) =>
    post<UploadTicket>(`${base(code)}/uploads`, { kind: "photo", content_type: contentType, size }),
  completeUpload: (code: string, id: string) =>
    post<{ id: string; status: string }>(`${base(code)}/uploads/${id}/complete`),
  myMedia: (code: string) => request<{ media: MyMedia[] }>(`${base(code)}/me/media`),
};

export function putWithProgress(
  ticket: UploadTicket["upload"],
  body: Blob,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(ticket.method, ticket.url);
    for (const [name, value] of Object.entries(ticket.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
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
