import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { listHostEvents, type HostEventDto } from "../lib/hostApi";
import { HostLayout } from "./HostLayout";
import styles from "./host.module.css";

export function HostDashboard() {
  const [events, setEvents] = useState<HostEventDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const alive = { current: true };
    void listHostEvents()
      .then((rows) => {
        if (alive.current) setEvents(rows);
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
  }, []);

  return (
    <HostLayout>
      <div className={styles.pageHeader}>
        <div>
          <h1>Your events</h1>
          <p className={styles.muted}>Create an event and share the QR code with guests.</p>
        </div>
        <Link to="/host/new" className={styles.primaryButton}>
          New event
        </Link>
      </div>

      {loading ? <p className={styles.muted}>Loading…</p> : null}
      {error ? <p className={styles.error}>{error}</p> : null}

      {!loading && events.length === 0 ? (
        <div className={styles.empty}>
          <p>No events yet.</p>
          <Link to="/host/new" className={styles.primaryButton}>
            Create your first event
          </Link>
        </div>
      ) : null}

      <ul className={styles.eventList}>
        {events.map((event) => (
          <li key={event.id}>
            <Link to={`/host/events/${event.id}`} className={styles.eventCard}>
              <strong>{event.name}</strong>
              <span className={styles.muted}>{event.revealMode} reveal</span>
              {event.startsAt ? <span className={styles.muted}>{event.startsAt}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </HostLayout>
  );
}
