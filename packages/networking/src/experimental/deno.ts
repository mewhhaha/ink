import type { Transport } from "./networking.ts";
export interface AuthoritativePeer {
  readonly id: string;
  readonly transport: Transport;
}
export interface DenoAuthoritativeSession {
  open(peer: AuthoritativePeer): void;
  message(peer: AuthoritativePeer, bytes: Uint8Array): void;
  close(peer: AuthoritativePeer): void;
}
export function deno_authoritative_handler(
  session: DenoAuthoritativeSession,
): (request: Request) => Response {
  let next = 0;
  return (request) => {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const { socket, response } = Deno.upgradeWebSocket(request);
    const id = `peer-${next++}`;
    const transport: Transport = {
      capabilities: {
        guarantees: ["reliable_ordered"],
        maximum_message_bytes: 64 * 1024,
      },
      send: (_channel, payload) =>
        socket.send(payload.slice().buffer as ArrayBuffer),
      close: (reason) => socket.close(1000, reason.slice(0, 123)),
    };
    const peer = Object.freeze({ id, transport });
    socket.onopen = () => session.open(peer);
    socket.onmessage = (event) => {
      const bytes = event.data instanceof ArrayBuffer
        ? new Uint8Array(event.data)
        : typeof event.data === "string"
        ? new TextEncoder().encode(event.data)
        : new Uint8Array();
      session.message(peer, bytes);
    };
    socket.onclose = () => session.close(peer);
    return response;
  };
}
