import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  deleteHostMedia,
  eventZipUrl,
  listHostEvents,
  listHostMedia,
  qrImageUrl,
  setMediaHidden,
} from "../lib/hostApi";
import type { HostEventDto, HostMediaItem } from "../lib/hostTypes";
import { HostLayout } from "./HostLayout";
import styles from "./host.module.css";

export function EventDetail() {
  const { id } = useParams();
  const [event, setEvent] = useState<HostEventDto | null>(null);
  const [media, setMedia] = useState<HostMediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [modError, setModError] = useState<string | null>(null);

  const refreshMedia = useCallback(async (eventId: string) => {
    const rows = await listHostMedia(eventId);
    setMedia(rows);
  }, []);

  useEffect(() => {
    if (!id) {
      return;
    }
    const alive = { current: true };
    void listHostEvents()
      .then((events) => {
        const row = events.find((item) => item.id === id);
        if (!row) {
          throw new Error("not_found");
        }
        if (alive.current) setEvent(row);
        return refreshMedia(id);
      })
      .catch((err: unknown) => {
        if (alive.current) setError(err instanceof Error ? err.message : "load_failed");
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
  }, [id, refreshMedia]);

  const copyLink = useCallback(async () => {
    if (!event) {
      return;
    }
    await navigator.clipboard.writeText(event.guestUrl);
    setCopied(true);
    window.setTimeout(() => {
      setCopied(false);
    }, 2000);
  }, [event]);

  const downloadSvg = useCallback(async () => {
    if (!id) {
      return;
    }
    const response = await fetch(qrImageUrl(id));
    const svg = await response.text();
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${event?.joinCode ?? "event"}-qr.svg`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [event?.joinCode, id]);

  const downloadPng = useCallback(async () => {
    if (!id) {
      return;
    }
    const response = await fetch(qrImageUrl(id));
    const svgText = await response.text();
    const blob = new Blob([svgText], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => {
        resolve();
      };
      image.onerror = () => {
        reject(new Error("png_failed"));
      };
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("png_failed");
    }
    ctx.drawImage(image, 0, 0);
    URL.revokeObjectURL(url);
    canvas.toBlob((pngBlob) => {
      if (!pngBlob) {
        return;
      }
      const pngUrl = URL.createObjectURL(pngBlob);
      const anchor = document.createElement("a");
      anchor.href = pngUrl;
      anchor.download = `${event?.joinCode ?? "event"}-qr.png`;
      anchor.click();
      URL.revokeObjectURL(pngUrl);
    }, "image/png");
  }, [event?.joinCode, id]);

  async function toggleHidden(item: HostMediaItem) {
    if (!id) return;
    setModError(null);
    try {
      await setMediaHidden(id, item.id, !item.hidden);
      await refreshMedia(id);
    } catch (err: unknown) {
      setModError(err instanceof Error ? err.message : "update_failed");
    }
  }

  async function remove(item: HostMediaItem) {
    if (!id) return;
    if (!window.confirm("Delete this item permanently?")) return;
    setModError(null);
    try {
      await deleteHostMedia(id, item.id);
      await refreshMedia(id);
    } catch (err: unknown) {
      setModError(err instanceof Error ? err.message : "delete_failed");
    }
  }

  return (
    <HostLayout>
      {loading ? <p className={styles.muted}>Loading…</p> : null}
      {error ? <p className={styles.error}>{error}</p> : null}
      {modError ? <p className={styles.error}>{modError}</p> : null}

      {event ? (
        <>
          <div className={styles.pageHeader}>
            <div>
              <h1>{event.name}</h1>
              <p className={styles.muted}>Share this QR code or link with guests.</p>
            </div>
            <Link to={`/host/events/${event.id}/edit`} className={styles.secondaryButton}>
              Edit
            </Link>
          </div>

          <div className={styles.detailGrid}>
            <div className={styles.qrPanel}>
              <img
                src={qrImageUrl(event.id)}
                alt={`QR code for ${event.name}`}
                className={styles.qrImage}
              />
              <div className={styles.buttonRow}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void downloadSvg()}
                >
                  Download SVG
                </button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void downloadPng()}
                >
                  Download PNG
                </button>
              </div>
            </div>

            <div className={styles.metaPanel}>
              <label className={styles.field}>
                <span>Guest link</span>
                <div className={styles.copyRow}>
                  <input readOnly value={event.guestUrl} />
                  <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={() => void copyLink()}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </label>
              <p className={styles.muted}>Join code: {event.joinCode}</p>
              <p className={styles.muted}>Reveal: {event.revealMode}</p>
              {event.revealAt ? <p className={styles.muted}>Reveal at: {event.revealAt}</p> : null}
              <p className={styles.muted}>Video max: {event.videoMaxSeconds}s</p>
              <a className={styles.primaryButton} href={eventZipUrl(event.id)}>
                Download album ZIP
              </a>
              <p className={styles.muted}>
                ZIP includes up to 200 ready, visible items (photos from R2, videos as MP4).
              </p>
            </div>
          </div>

          <section className={styles.moderation}>
            <h2>Album moderation</h2>
            <p className={styles.muted}>
              Hosts see every upload, including hidden and processing items.
            </p>
            {media.length === 0 ? (
              <p className={styles.muted}>No uploads yet.</p>
            ) : (
              <ul className={styles.mediaGrid}>
                {media.map((item) => (
                  <li key={item.id} className={item.hidden ? styles.mediaHidden : undefined}>
                    {item.kind === "video" ? (
                      <img src={item.poster_url ?? ""} alt="" className={styles.mediaThumb} />
                    ) : (
                      <img
                        src={item.thumb_url ?? item.web_url ?? ""}
                        alt=""
                        className={styles.mediaThumb}
                      />
                    )}
                    <div className={styles.mediaMeta}>
                      <span>{item.display_name ?? "Guest"}</span>
                      <span className={styles.muted}>
                        {item.status}
                        {item.hidden ? " · hidden" : ""}
                      </span>
                    </div>
                    <div className={styles.buttonRow}>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => void toggleHidden(item)}
                      >
                        {item.hidden ? "Unhide" : "Hide"}
                      </button>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => void remove(item)}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </HostLayout>
  );
}
