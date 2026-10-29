import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { api, type EventInfo, type MyMedia } from "../lib/api";
import { VideoRecorder } from "../components/VideoRecorder";
import { canRecord } from "../lib/video";
import { useUploadQueue, type UploadItem } from "../lib/useUploadQueue";

type Props = { code: string; event: EventInfo; displayName: string };

const POLL_MS = 4000;
const canStream = typeof navigator !== "undefined" && "mediaDevices" in navigator;

function statusLabel(item: UploadItem): string {
  switch (item.status) {
    case "queued":
      return "Waiting…";
    case "preparing":
      return "Preparing…";
    case "uploading":
      return `${String(Math.round(item.progress * 100))}%`;
    case "finalizing":
      return "Finishing…";
    case "done":
      return item.kind === "video" ? "Uploaded, processing…" : "Uploaded";
    case "error":
      return item.error ?? "Failed";
    default: {
      const unreachable: never = item.status;
      return unreachable;
    }
  }
}

export function Camera({ code, event, displayName }: Props) {
  const [earlier, setEarlier] = useState<MyMedia[]>([]);
  const refreshEarlier = useCallback(() => {
    api
      .myMedia(code)
      .then((res) => {
        setEarlier(res.media);
      })
      .catch(() => undefined);
  }, [code]);
  useEffect(refreshEarlier, [refreshEarlier]);

  const processingCount = earlier.filter(
    (m) => m.kind === "video" && m.status === "pending",
  ).length;
  useEffect(() => {
    if (processingCount === 0) return;
    const timer = window.setInterval(refreshEarlier, POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [processingCount, refreshEarlier]);

  const { items, enqueue, retry, dismiss } = useUploadQueue(code, refreshEarlier);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [live, setLive] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  const stopLive = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => {
      t.stop();
    });
    streamRef.current = null;
    setLive(false);
  }, []);
  useEffect(() => stopLive, [stopLive]);

  async function startLive() {
    setLiveError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
        audio: false,
      });
      streamRef.current = stream;
      setLive(true);
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
    } catch {
      stopLive();
      setLiveError("Camera unavailable. Use the buttons below instead.");
    }
  }

  function snap() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) enqueue([Object.assign(blob, { name: `capture-${String(Date.now())}.jpg` })]);
      },
      "image/jpeg",
      0.92,
    );
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (picked.length > 0) enqueue(picked);
  }

  const doneCount = items.filter((i) => i.status === "done").length;
  const uploadedEarlier = earlier.length;

  return (
    <main className="camera">
      <header>
        <h1>{event.name}</h1>
        <p className="muted">
          Hi {displayName}!{" "}
          {uploadedEarlier + doneCount > 0
            ? `${String(Math.max(uploadedEarlier, doneCount))} shared so far.`
            : "Add your first photo."}
        </p>
      </header>

      {canStream ? (
        <section className="viewfinder" hidden={!live}>
          <video ref={videoRef} playsInline muted autoPlay />
          <div className="viewfinder-actions">
            <button type="button" className="btn ghost" onClick={stopLive}>
              Close
            </button>
            <button type="button" className="shutter" aria-label="Take photo" onClick={snap} />
          </div>
        </section>
      ) : null}

      <section className="actions">
        <label className="btn primary big">
          Take a photo
          <input type="file" accept="image/*" capture="environment" onChange={onPick} hidden />
        </label>
        <label className="btn secondary big">
          Choose from camera roll
          <input type="file" accept="image/*" multiple onChange={onPick} hidden />
        </label>
        <label className="btn secondary big">
          Take a video
          <input type="file" accept="video/*" capture="environment" onChange={onPick} hidden />
        </label>
        <label className="btn secondary big">
          Choose videos
          <input type="file" accept="video/*" multiple onChange={onPick} hidden />
        </label>
        {canRecord ? (
          <VideoRecorder
            maxSeconds={event.video_max_seconds}
            onRecorded={(file) => {
              enqueue([file]);
            }}
          />
        ) : null}
        {canStream && !live ? (
          <button type="button" className="btn ghost" onClick={() => void startLive()}>
            Open live camera
          </button>
        ) : null}
        {liveError ? <p className="error">{liveError}</p> : null}
      </section>

      {processingCount > 0 ? (
        <p className="muted">
          Processing {processingCount} video{processingCount === 1 ? "" : "s"}…
        </p>
      ) : null}
      {earlier.some((m) => m.kind === "video" && m.status === "failed") ? (
        <p className="error">A video could not be processed (too long or unsupported).</p>
      ) : null}

      <ul className="queue">
        {items.map((item) => (
          <li key={item.id} className={`queue-item ${item.status}`}>
            {item.kind === "video" ? (
              <video src={item.previewUrl} muted playsInline preload="metadata" />
            ) : (
              <img src={item.previewUrl} alt="" />
            )}
            <div className="queue-info">
              <span className="queue-name">{item.name}</span>
              <span className="queue-status">{statusLabel(item)}</span>
              {item.status === "uploading" || item.status === "finalizing" ? (
                <progress value={item.progress} max={1} />
              ) : null}
            </div>
            {item.status === "error" && item.error !== "Retrying…" ? (
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  retry(item.id);
                }}
              >
                Retry
              </button>
            ) : null}
            {item.status === "done" || (item.status === "error" && item.error !== "Retrying…") ? (
              <button
                type="button"
                className="btn ghost small"
                aria-label="Dismiss"
                onClick={() => {
                  dismiss(item.id);
                }}
              >
                ✕
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </main>
  );
}
