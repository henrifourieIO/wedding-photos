import { parseEnvelope, serializeMessage } from "../lib/room";

const HOST_TAG = "host";
const GUEST_TAG = "guest";

export class EventRoom implements DurableObject {
  constructor(private readonly state: DurableObjectState) {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return this.accept(request, url);
    if (url.pathname === "/broadcast" && request.method === "POST") return this.broadcast(request);
    return new Response("not found", { status: 404 });
  }

  private accept(request: Request, url: URL): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const tag = url.searchParams.get("aud") === HOST_TAG ? HOST_TAG : GUEST_TAG;
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], [tag]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async broadcast(request: Request): Promise<Response> {
    const envelope = parseEnvelope(await request.json().catch(() => null));
    if (!envelope) return new Response("bad envelope", { status: 400 });
    const payload = serializeMessage(envelope.message);
    const sockets =
      envelope.audience === "host"
        ? this.state.getWebSockets(HOST_TAG)
        : this.state.getWebSockets();
    let sent = 0;
    for (const ws of sockets) {
      try {
        ws.send(payload);
        sent += 1;
      } catch {
        ws.close(1011, "send failed");
      }
    }
    return Response.json({ sent });
  }

  webSocketMessage(): void {}

  webSocketClose(ws: WebSocket): void {
    ws.close(1000);
  }

  webSocketError(ws: WebSocket): void {
    ws.close(1011, "error");
  }
}
