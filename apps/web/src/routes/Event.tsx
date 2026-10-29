import { useEffect, useState } from "react";
import { ApiError, api, type EventInfo } from "../lib/api";
import { Camera } from "./Camera";
import { Join } from "./Join";

type State =
  | { phase: "loading" }
  | { phase: "missing" }
  | { phase: "error" }
  | { phase: "join"; event: EventInfo }
  | { phase: "camera"; event: EventInfo; displayName: string };

export function Event({ code }: { code: string }) {
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const event = await api.getEvent(code);
        const me = await api.getMe(code).catch(() => null);
        if (cancelled) return;
        setState(
          me ? { phase: "camera", event, displayName: me.display_name } : { phase: "join", event },
        );
      } catch (err) {
        if (cancelled) return;
        setState({ phase: err instanceof ApiError && err.status === 404 ? "missing" : "error" });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [code]);

  switch (state.phase) {
    case "loading":
      return (
        <main className="landing">
          <p className="muted">Loading…</p>
        </main>
      );
    case "missing":
      return (
        <main className="landing">
          <h1>Event not found</h1>
          <p>Check the QR code or link and try again.</p>
        </main>
      );
    case "error":
      return (
        <main className="landing">
          <h1>Something went wrong</h1>
          <p>Please reload the page.</p>
        </main>
      );
    case "join":
      return (
        <Join
          code={code}
          event={state.event}
          onJoined={(displayName) => {
            setState({ phase: "camera", event: state.event, displayName });
          }}
        />
      );
    case "camera":
      return <Camera code={code} event={state.event} displayName={state.displayName} />;
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}
