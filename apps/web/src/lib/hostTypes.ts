export type RevealMode = "instant" | "delayed" | "private";

export type HostMediaItem = {
  id: string;
  kind: "photo" | "video";
  status: string;
  hidden: boolean;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  taken_at: string | null;
  created_at: string;
  thumb_url: string | null;
  web_url: string | null;
  poster_url: string | null;
  hls_url: string | null;
  guest_id: string | null;
  display_name: string | null;
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
