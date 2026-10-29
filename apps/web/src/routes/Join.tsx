import { useState, type SyntheticEvent } from "react";
import { ApiError, api, type EventInfo } from "../lib/api";

type Props = {
  code: string;
  event: EventInfo;
  onJoined: (displayName: string) => void;
};

export function Join({ code, event, onJoined }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: SyntheticEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const guest = await api.join(code, trimmed);
      onJoined(guest.display_name);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? "Too many attempts, try again in a few minutes."
          : "Could not join. Please try again.",
      );
      setBusy(false);
    }
  }

  return (
    <main className="join">
      {event.cover_url ? <img className="join-cover" src={event.cover_url} alt="" /> : null}
      <h1>{event.name}</h1>
      <p className="muted">Share your photos with the happy couple.</p>
      <form onSubmit={(e) => void submit(e)}>
        <label htmlFor="display-name">Your name</label>
        <input
          id="display-name"
          type="text"
          autoComplete="given-name"
          maxLength={60}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          placeholder="e.g. Aunt Sarah"
          required
        />
        {error ? <p className="error">{error}</p> : null}
        <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
          {busy ? "Joining…" : "Join the album"}
        </button>
      </form>
    </main>
  );
}
