import { useCallback, useEffect, useRef, useState } from "react";

type Props = { maxSeconds: number; onRecorded: (file: File) => void };

const MIME_CANDIDATES = ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm"];

function pickMime(): string | undefined {
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

export function VideoRecorder({ maxSeconds, onRecorded }: Props) {
  const previewRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const release = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => {
      t.stop();
    });
    streamRef.current = null;
    recorderRef.current = null;
    setRemaining(null);
    setOpen(false);
  }, []);
  useEffect(() => release, [release]);

  async function openCamera() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: true,
      });
      streamRef.current = stream;
      setOpen(true);
      requestAnimationFrame(() => {
        const preview = previewRef.current;
        if (preview) {
          preview.srcObject = stream;
          void preview.play();
        }
      });
    } catch {
      release();
      setError("Camera or microphone unavailable. Use the video button instead.");
    }
  }

  function start() {
    const stream = streamRef.current;
    if (!stream) return;
    const mimeType = pickMime();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      const type = (recorder.mimeType || mimeType || "video/webm").split(";")[0] ?? "video/webm";
      const ext = type === "video/mp4" ? "mp4" : "webm";
      const file = new File(chunks, `video-${String(Date.now())}.${ext}`, { type });
      release();
      if (file.size > 0) onRecorded(file);
    };
    recorderRef.current = recorder;
    recorder.start(1000);
    setRemaining(maxSeconds);
    timerRef.current = window.setInterval(() => {
      setRemaining((prev) => {
        if (prev === null) return prev;
        if (prev <= 1) {
          stop();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  function stop() {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  const recording = remaining !== null;

  return (
    <>
      {open ? (
        <section className="viewfinder">
          <video ref={previewRef} playsInline muted autoPlay />
          {recording ? <span className="countdown">{remaining}s</span> : null}
          <div className="viewfinder-actions">
            <button type="button" className="btn ghost" onClick={release}>
              Close
            </button>
            {recording ? (
              <button
                type="button"
                className="shutter recording"
                aria-label="Stop"
                onClick={stop}
              />
            ) : (
              <button type="button" className="shutter" aria-label="Record video" onClick={start} />
            )}
          </div>
        </section>
      ) : (
        <button type="button" className="btn ghost" onClick={() => void openCamera()}>
          Record video ({maxSeconds}s max)
        </button>
      )}
      {error ? <p className="error">{error}</p> : null}
    </>
  );
}
