export type PhotoQueueMessage = {
  mediaId: string;
  eventId: string;
};

export type RevealMode = "instant" | "delayed" | "private";

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

export type AppEnv = {
  Bindings: Cloudflare.Env;
  Variables: {
    hostSub: string;
  };
};

export type EventRow = {
  id: string;
  host_sub: string;
  name: string;
  starts_at: string | null;
  cover_key: string | null;
  join_code: string;
  reveal_mode: RevealMode;
  reveal_at: string | null;
  video_max_seconds: number;
  created_at: string;
};

export type HostEventDto = {
  id: string;
  name: string;
  startsAt: string | null;
  coverKey: string | null;
  joinCode: string;
  revealMode: RevealMode;
  revealAt: string | null;
  videoMaxSeconds: number;
  createdAt: string;
  guestUrl: string;
  coverUpload?: {
    key: string;
    uploadUrl: string;
  };
};
