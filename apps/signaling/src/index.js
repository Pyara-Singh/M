export class Room {
  constructor(state) { this.state = state; this.clients = new Map(); }
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID();
    server.accept(); this.clients.set(id, server);
    server.send(JSON.stringify({ type: "welcome", id })); this.broadcast({ type: "peer-joined", id }, id);
    server.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "signal" && typeof message.to === "string") this.clients.get(message.to)?.send(JSON.stringify({ ...message, from: id }));
        if (message.type === "peers") server.send(JSON.stringify({ type: "peers", peers: [...this.clients.keys()].filter((peerId) => peerId !== id) }));
      } catch { server.send(JSON.stringify({ type: "error", message: "Invalid message." })); }
    });
    const close = () => { if (this.clients.delete(id)) this.broadcast({ type: "peer-left", id }); };
    server.addEventListener("close", close); server.addEventListener("error", close);
    return new Response(null, { status: 101, webSocket: client });
  }
  broadcast(message, except) { const payload = JSON.stringify(message); for (const [id, socket] of this.clients) if (id !== except) socket.send(payload); }
}
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/signal") {
    const room = url.searchParams.get("room");
    if (!room || !/^[a-zA-Z0-9_-]{3,64}$/.test(room)) return new Response("Invalid room.", { status: 400 });
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  }
  return env.ASSETS.fetch(request);
} };
