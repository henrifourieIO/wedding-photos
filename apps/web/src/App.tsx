import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes, useParams } from "react-router-dom";
import { Event } from "./routes/Event";
import { Gallery } from "./routes/Gallery";
import { EventDetail } from "./routes/EventDetail";
import { EventForm } from "./routes/EventForm";
import { listHostEvents } from "./lib/hostApi";
import { Wall } from "./routes/Wall";
import { HostDashboard } from "./routes/HostDashboard";

const GUEST_WALL = /^\/e\/([A-Za-z0-9_-]+)\/wall\/?$/;
const GUEST_GALLERY = /^\/e\/([A-Za-z0-9_-]+)\/gallery\/?$/;
const GUEST_ROUTE = /^\/e\/([A-Za-z0-9_-]+)\/?$/;

function Landing() {
  return (
    <main className="landing">
      <h1>Wedding Photos</h1>
      <p>Scan the event QR code to share photos and videos with the album.</p>
      <p>
        <a href="/host">Host dashboard</a>
      </p>
    </main>
  );
}

function HostWall() {
  const { id } = useParams();
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    void listHostEvents().then((events) => {
      setCode(events.find((e) => e.id === id)?.joinCode ?? null);
    });
  }, [id]);
  return code && id ? <Wall code={code} livePath={`/api/host/events/${id}/live`} /> : null;
}

function HostRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/host" element={<HostDashboard />} />
        <Route path="/host/new" element={<EventForm />} />
        <Route path="/host/events/:id" element={<EventDetail />} />
        <Route path="/host/events/:id/wall" element={<HostWall />} />
        <Route path="/host/events/:id/edit" element={<EventForm />} />
      </Routes>
    </BrowserRouter>
  );
}

export function App() {
  const wallMatch = GUEST_WALL.exec(window.location.pathname);
  if (wallMatch?.[1]) {
    return <Wall code={wallMatch[1]} livePath={`/api/events/${wallMatch[1]}/live`} />;
  }
  const galleryMatch = GUEST_GALLERY.exec(window.location.pathname);
  if (galleryMatch?.[1]) return <Gallery code={galleryMatch[1]} />;

  const match = GUEST_ROUTE.exec(window.location.pathname);
  if (match?.[1]) return <Event code={match[1]} />;

  const path = window.location.pathname;
  if (path === "/host" || path.startsWith("/host/")) {
    return <HostRoutes />;
  }

  return <Landing />;
}
