import { useCallback, useEffect, useRef, useState } from "react";
import { api, type GalleryItem } from "../lib/api";
import { useLive, type LiveMessage } from "../lib/useLive";
import { VideoPlayer } from "../components/VideoPlayer";
import styles from "./wall.module.css";

const SLIDE_MS = 7000;
const RECHECK_MS = 30_000;
const MAX_ITEMS = 500;

type Props = { code: string; livePath: string };

function mergeItem(items: GalleryItem[], item: GalleryItem): GalleryItem[] {
  if (items.some((i) => i.id === item.id)) return items;
  return [item, ...items].slice(0, MAX_ITEMS);
}

export function Wall({ code, livePath }: Props) {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [visible, setVisible] = useState(true);
  const [index, setIndex] = useState(0);
  const fresh = useRef<string[]>([]);

  const load = useCallback(async () => {
    try {
      const page = await api.getGallery(code);
      setVisible(page.gallery_visible);
      setItems(page.items);
    } catch {
      /* retried by the recheck timer */
    }
  }, [code]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), RECHECK_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [load]);

  const onMessage = useCallback((m: LiveMessage) => {
    switch (m.type) {
      case "media.ready":
        fresh.current.push(m.item.id);
        setItems((prev) => mergeItem(prev, m.item));
        return;
      case "media.hidden":
      case "media.deleted":
        setItems((prev) => prev.filter((i) => i.id !== m.id));
        return;
      case "media.failed":
        return;
      default: {
        const never: never = m;
        throw new Error(`unhandled ${JSON.stringify(never)}`);
      }
    }
  }, []);
  useLive(livePath, onMessage, () => void load());

  const count = items.length;
  useEffect(() => {
    if (count === 0) return;
    const id = window.setTimeout(() => {
      const nextFresh = fresh.current.shift();
      setIndex((i) => {
        const at = nextFresh ? items.findIndex((x) => x.id === nextFresh) : -1;
        return at >= 0 ? at : (i + 1) % count;
      });
    }, SLIDE_MS);
    return () => {
      window.clearTimeout(id);
    };
  }, [index, count, items]);

  useEffect(() => {
    const request = document.documentElement.requestFullscreen.bind(document.documentElement);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "f") void request().catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const current = items[index % Math.max(count, 1)];
  let body;
  if (!visible) body = <p className={styles.message}>Photos will appear here once revealed.</p>;
  else if (!current) body = <p className={styles.message}>Waiting for the first photo…</p>;
  else if (current.kind === "video" && current.hls_url) {
    body = (
      <VideoPlayer
        key={current.id}
        hlsUrl={current.hls_url}
        posterUrl={current.poster_url}
        className={styles.media}
        autoPlay
      />
    );
  } else {
    body = (
      <img
        key={current.id}
        className={styles.media}
        src={current.web_url ?? current.thumb_url ?? current.poster_url ?? ""}
        alt=""
      />
    );
  }

  return (
    <main
      className={styles.wall}
      onDoubleClick={() => void document.documentElement.requestFullscreen()}
    >
      {body}
    </main>
  );
}
