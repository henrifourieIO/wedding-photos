import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, type GalleryItem, type GalleryPage } from "../lib/api";
import { useLive } from "../lib/useLive";
import { VideoPlayer } from "../components/VideoPlayer";
import styles from "./gallery.module.css";

const POLL_MS = 30_000;

type Props = { code: string };

type Phase =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error" }
  | { kind: "ready"; page: GalleryPage };

function useCountdown(revealAt: string | null, active: boolean): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!active || !revealAt) {
      setLabel(null);
      return;
    }
    const tick = () => {
      const ms = Date.parse(revealAt) - Date.now();
      if (Number.isNaN(ms) || ms <= 0) {
        setLabel(null);
        return;
      }
      const total = Math.floor(ms / 1000);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      setLabel(
        h > 0
          ? `${String(h)}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
          : `${String(m)}:${String(s).padStart(2, "0")}`,
      );
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [revealAt, active]);
  return label;
}

async function saveOrShare(item: GalleryItem) {
  const url =
    item.kind === "photo"
      ? (item.web_url ?? item.thumb_url ?? "")
      : (item.poster_url ?? item.hls_url ?? "");
  if (!url) return;
  const absolute = url.startsWith("http") ? url : `${window.location.origin}${url}`;
  if ("share" in navigator && typeof navigator.share === "function") {
    try {
      await navigator.share({ title: "Wedding photo", url: absolute });
      return;
    } catch {
      /* fall through to download */
    }
  }
  const href =
    item.kind === "photo" && item.web_url
      ? item.web_url
      : item.kind === "photo" && item.thumb_url
        ? item.thumb_url
        : absolute;
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `${item.id}.${item.kind === "photo" ? "jpg" : "mp4"}`;
  anchor.rel = "noopener";
  anchor.click();
}

export function Gallery({ code }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [lightbox, setLightbox] = useState<GalleryItem | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await api.getGallery(code);
      setPhase({ kind: "ready", page });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setPhase({ kind: "missing" });
      else setPhase({ kind: "error" });
    }
  }, [code]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (phase.kind !== "ready") return;
    const id = window.setInterval(() => {
      void load();
    }, POLL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [phase.kind, load]);

  const reload = useCallback(() => {
    void load();
  }, [load]);
  useLive(`/api/events/${encodeURIComponent(code)}/live`, reload, reload);

  const waiting =
    phase.kind === "ready" && !phase.page.gallery_visible && phase.page.reveal_mode === "delayed";
  const countdown = useCountdown(phase.kind === "ready" ? phase.page.reveal_at : null, waiting);

  const items = phase.kind === "ready" ? phase.page.items : [];

  const title = useMemo(() => {
    if (phase.kind !== "ready") return "Gallery";
    if (!phase.page.gallery_visible && phase.page.reveal_mode === "private") {
      return "Host-only album";
    }
    return "Gallery";
  }, [phase]);

  if (phase.kind === "loading") {
    return (
      <main className={styles.shell}>
        <p className="muted">Loading…</p>
      </main>
    );
  }
  if (phase.kind === "missing") {
    return (
      <main className={styles.shell}>
        <h1>Event not found</h1>
      </main>
    );
  }
  if (phase.kind === "error") {
    return (
      <main className={styles.shell}>
        <h1>Something went wrong</h1>
      </main>
    );
  }

  const page = phase.page;

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <h1>{title}</h1>
          {!page.gallery_visible && page.reveal_mode === "delayed" ? (
            <p className="muted">Photos unlock soon{countdown ? ` — ${countdown}` : ""}.</p>
          ) : null}
          {!page.gallery_visible && page.reveal_mode === "private" ? (
            <p className="muted">Only the host can view this album.</p>
          ) : null}
        </div>
        <div>
          <a className="btn secondary" href={`/e/${encodeURIComponent(code)}/wall`}>
            Live wall
          </a>{" "}
          <a className="btn secondary" href={`/e/${encodeURIComponent(code)}`}>
            Add photos
          </a>
        </div>
      </header>

      {page.gallery_visible && items.length === 0 ? (
        <div className={styles.empty}>
          <p>No photos yet.</p>
          <a className="btn primary" href={`/e/${encodeURIComponent(code)}`}>
            Be the first
          </a>
        </div>
      ) : null}

      {page.gallery_visible && items.length > 0 ? (
        <div className={styles.masonry}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.tile}
              onClick={() => {
                setLightbox(item);
              }}
            >
              {item.kind === "video" ? (
                <img
                  src={item.poster_url ?? item.thumb_url ?? ""}
                  alt=""
                  loading="lazy"
                  className={styles.tileMedia}
                />
              ) : (
                <img
                  src={item.thumb_url ?? item.web_url ?? ""}
                  alt=""
                  loading="lazy"
                  className={styles.tileMedia}
                />
              )}
              {item.kind === "video" ? <span className={styles.badge}>Video</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      {lightbox ? (
        <div
          className={styles.lightbox}
          role="dialog"
          aria-modal="true"
          onClick={() => {
            setLightbox(null);
          }}
        >
          <div
            className={styles.lightboxInner}
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            {lightbox.kind === "video" && lightbox.hls_url ? (
              <VideoPlayer hlsUrl={lightbox.hls_url} posterUrl={lightbox.poster_url} autoPlay />
            ) : (
              <img src={lightbox.web_url ?? lightbox.thumb_url ?? ""} alt="" />
            )}
            <div className={styles.lightboxActions}>
              <button
                type="button"
                className="btn primary"
                onClick={() => void saveOrShare(lightbox)}
              >
                Save / share
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setLightbox(null);
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
