import type { HostEventDto, HostMediaItem, RevealMode } from "./hostTypes";

export type { HostEventDto, HostMediaItem, RevealMode };

export type UpsertEventInput = {
  name: string;
  startsAt?: string | null;
  revealMode: RevealMode;
  revealAt?: string | null;
  videoMaxSeconds?: number;
  coverContentType?: string;
};

async function hostFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`/api/host${path}`, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${String(response.status)})`);
  }
  return response.json() as Promise<T>;
}

export async function listHostEvents(): Promise<HostEventDto[]> {
  const data = await hostFetch<{ events: HostEventDto[] }>("/events");
  return data.events;
}

export async function createHostEvent(input: UpsertEventInput): Promise<HostEventDto> {
  const data = await hostFetch<{ event: HostEventDto }>("/events", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.event;
}

export async function updateHostEvent(
  id: string,
  input: Partial<UpsertEventInput>,
): Promise<HostEventDto> {
  const data = await hostFetch<{ event: HostEventDto }>(`/events/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return data.event;
}

export async function uploadCover(uploadUrl: string, file: File): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!response.ok) {
    throw new Error("cover_upload_failed");
  }
}

export function qrImageUrl(eventId: string): string {
  return `/api/host/events/${eventId}/qr`;
}

export async function listHostMedia(eventId: string): Promise<HostMediaItem[]> {
  const data = await hostFetch<{ media: HostMediaItem[] }>(`/events/${eventId}/media`);
  return data.media;
}

export async function setMediaHidden(
  eventId: string,
  mediaId: string,
  hidden: boolean,
): Promise<void> {
  await hostFetch(`/events/${eventId}/media/${mediaId}`, {
    method: "PATCH",
    body: JSON.stringify({ hidden }),
  });
}

export async function deleteHostMedia(eventId: string, mediaId: string): Promise<void> {
  const response = await fetch(`/api/host/events/${eventId}/media/${mediaId}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "delete_failed");
  }
}

export function eventZipUrl(eventId: string): string {
  return `/api/host/events/${eventId}/zip`;
}
