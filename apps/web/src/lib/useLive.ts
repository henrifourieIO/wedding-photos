import { useEffect, useRef } from "react";
import type { GalleryItem } from "./api";

export type LiveMessage =
  | { type: "media.ready"; item: GalleryItem }
  | { type: "media.failed"; id: string }
  | { type: "media.hidden"; id: string }
  | { type: "media.deleted"; id: string };

const PING_MS = 25_000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15_000;

function parseMessage(raw: unknown): LiveMessage | null {
  if (typeof raw !== "string") return null;
  try {
    const m = JSON.parse(raw) as LiveMessage;
    return typeof m.type === "string" ? m : null;
  } catch {
    return null;
  }
}

export function useLive(
  path: string | null,
  onMessage: (message: LiveMessage) => void,
  onOpen?: () => void,
): void {
  const handler = useRef(onMessage);
  const opened = useRef(onOpen);
  handler.current = onMessage;
  opened.current = onOpen;

  useEffect(() => {
    if (!path) return;
    let socket: WebSocket | null = null;
    let timer = 0;
    let ping = 0;
    let delay = RETRY_MIN_MS;
    let stopped = false;

    const connect = () => {
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${scheme}//${window.location.host}${path}`);
      socket = ws;
      ws.onopen = () => {
        delay = RETRY_MIN_MS;
        opened.current?.();
        ping = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, PING_MS);
      };
      ws.onmessage = (e: MessageEvent<unknown>) => {
        const message = parseMessage(e.data);
        if (message) handler.current(message);
      };
      ws.onclose = () => {
        window.clearInterval(ping);
        if (stopped) return;
        timer = window.setTimeout(connect, delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      };
    };
    connect();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearInterval(ping);
      socket?.close();
    };
  }, [path]);
}
