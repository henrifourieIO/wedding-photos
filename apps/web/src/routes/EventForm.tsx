import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  createHostEvent,
  listHostEvents,
  updateHostEvent,
  uploadCover,
  type UpsertEventInput,
} from "../lib/hostApi";
import type { RevealMode } from "../lib/hostTypes";
import { HostLayout } from "./HostLayout";
import styles from "./host.module.css";

const revealModes: RevealMode[] = ["instant", "delayed", "private"];

export function EventForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  const [name, setName] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [revealMode, setRevealMode] = useState<RevealMode>("instant");
  const [revealAt, setRevealAt] = useState("");
  const [videoMaxSeconds, setVideoMaxSeconds] = useState(60);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      return;
    }
    const alive = { current: true };
    void listHostEvents()
      .then((events) => {
        const event = events.find((row) => row.id === id);
        if (!event) {
          throw new Error("not_found");
        }
        if (!alive.current) return;
        setName(event.name);
        setStartsAt(event.startsAt ?? "");
        setRevealMode(event.revealMode);
        setRevealAt(event.revealAt ?? "");
        setVideoMaxSeconds(event.videoMaxSeconds);
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
  }, [id]);

  async function onSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload: UpsertEventInput = {
        name,
        startsAt: startsAt || null,
        revealMode,
        revealAt: revealMode === "delayed" ? revealAt || null : null,
        videoMaxSeconds,
        coverContentType: coverFile?.type,
      };

      const event = isEdit && id ? await updateHostEvent(id, payload) : await createHostEvent(payload);

      if (coverFile && event.coverUpload) {
        await uploadCover(event.coverUpload.uploadUrl, coverFile);
      }

      void navigate(`/host/events/${event.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save_failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <HostLayout>
      <div className={styles.pageHeader}>
        <div>
          <h1>{isEdit ? "Edit event" : "New event"}</h1>
          <p className={styles.muted}>Set album settings and optional cover photo.</p>
        </div>
        <Link to={id ? `/host/events/${id}` : "/host"} className={styles.secondaryButton}>
          Cancel
        </Link>
      </div>

      {loading ? <p className={styles.muted}>Loading…</p> : null}
      {error ? <p className={styles.error}>{error}</p> : null}

      {!loading ? (
        <form
          className={styles.form}
          onSubmit={(e) => {
            void onSubmit(e);
          }}
        >
          <label className={styles.field}>
            <span>Event name</span>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              required
              maxLength={120}
            />
          </label>

          <label className={styles.field}>
            <span>Starts at (optional)</span>
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => {
                setStartsAt(e.target.value);
              }}
            />
          </label>

          <label className={styles.field}>
            <span>Reveal mode</span>
            <select
              value={revealMode}
              onChange={(e) => {
                setRevealMode(e.target.value as RevealMode);
              }}
            >
              {revealModes.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </label>

          {revealMode === "delayed" ? (
            <label className={styles.field}>
              <span>Reveal at</span>
              <input
                type="datetime-local"
                value={revealAt}
                onChange={(e) => {
                  setRevealAt(e.target.value);
                }}
                required
              />
            </label>
          ) : null}

          <label className={styles.field}>
            <span>Max video length (seconds)</span>
            <input
              type="number"
              min={5}
              max={300}
              value={videoMaxSeconds}
              onChange={(e) => {
                setVideoMaxSeconds(Number(e.target.value));
              }}
            />
          </label>

          <label className={styles.field}>
            <span>Cover photo (optional)</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              onChange={(e) => {
                setCoverFile(e.target.files?.[0] ?? null);
              }}
            />
          </label>

          <button type="submit" className={styles.primaryButton} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create event"}
          </button>
        </form>
      ) : null}
    </HostLayout>
  );
}
