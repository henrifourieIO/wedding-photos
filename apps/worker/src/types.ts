export type PhotoQueueMessage = {
  mediaId: string;
  eventId: string;
};

export type RevealMode = "instant" | "delayed" | "private";

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
