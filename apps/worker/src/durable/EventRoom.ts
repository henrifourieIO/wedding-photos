export class EventRoom implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  fetch(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      return new Response("WebSocket not implemented yet", { status: 501 });
    }
    return new Response(`EventRoom:${this.state.id.toString()}`, { status: 200 });
  }
}
