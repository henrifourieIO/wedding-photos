import { Event } from "./routes/Event";

const GUEST_ROUTE = /^\/e\/([A-Za-z0-9_-]+)\/?$/;

export function App() {
  const match = GUEST_ROUTE.exec(window.location.pathname);
  if (match?.[1]) return <Event code={match[1]} />;
  return (
    <main className="landing">
      <h1>Wedding Photos</h1>
      <p>Scan the event QR code to share photos and videos with the album.</p>
    </main>
  );
}
