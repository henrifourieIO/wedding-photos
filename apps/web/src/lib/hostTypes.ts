export type RevealMode = "instant" | "delayed" | "private";

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
