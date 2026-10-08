import { assert, assertEquals } from "@std/assert";
import { EventEmitter } from "node:events";
import type { ViteDevServer, WebSocketClient } from "vite";
import type { JoinGame, NetworkReceive, NetworkSend } from "@ink/core";
import { MultiplayerHost } from "./multiplayer_host.ts";

function fixture() {
  const events = new EventEmitter();
  const host = new MultiplayerHost(
    {
      ws: { on: events.on.bind(events), off: events.off.bind(events) },
    } as unknown as ViteDevServer,
  );
  const client = (channel: string) => {
    const received: NetworkReceive[] = [];
    const socket = {
      socket: new EventEmitter(),
      send: (data: { data: { channel: string; message: NetworkReceive } }) => {
        assertEquals(data.data.channel, channel);
        received.push(data.data.message);
      },
    } as unknown as WebSocketClient;
    return {
      received,
      socket,
      send: (message: NetworkSend) =>
        host.receive({ channel, message }, socket),
    };
  };
  const join: JoinGame = {
    kind: "join",
    room: "test",
    identity: "build-1",
    state: [1, 0, 1, 0, 1, 0, 7],
    names: [],
    tickRate: 60,
    delayMs: 10,
    mode: "rollback",
  };
  return { host, client, join };
}

Deno.test("rooms reject mismatched builds and extra players; relay assigns ids and cancels delayed packets on disconnect", async () => {
  const { host, client, join } = fixture();
  try {
    const a = client("a"), b = client("b"), c = client("c");
    a.send(join);
    b.send({ ...join, identity: "wrong-build" });
    assertEquals(b.received.at(-1)?.kind, "closed");
    assertEquals(a.received.at(-1)?.kind, "waiting");
    b.send(join);
    c.send(join);
    assertEquals(c.received.at(-1), { kind: "closed", reason: "room is full" });
    a.send({ kind: "ready" });
    assertEquals(a.received.at(-1)?.kind, "prepare");
    b.send({ kind: "ready" });
    assertEquals(a.received.at(-1)?.kind, "go");
    // An old channel cannot submit input into a newer connection.
    host.receive({
      channel: "old-a",
      message: { kind: "input", lanes: Array(23).fill(0) },
    }, a.socket);
    a.send({ kind: "input", lanes: Array(23).fill(0), peer: 1 } as NetworkSend);
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(b.received.filter((m) => m.kind === "input"), [{
      kind: "input",
      peer: 0,
      lanes: Array(23).fill(0),
    }]);
    a.send({ kind: "input", lanes: Array(23).fill(1) });
    a.socket.socket.emit("close");
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(b.received.filter((m) => m.kind === "input").length, 1);
    assertEquals(b.received.at(-1)?.kind, "closed");
    c.send(join);
    assertEquals(
      c.received.at(-1)?.kind,
      "waiting",
      "a closed room can be rejoined",
    );
    c.send({ kind: "input", lanes: [NaN] });
    assertEquals(c.received.at(-1)?.kind, "closed");
  } finally {
    host.dispose();
  }
});

Deno.test("invalid room snapshots are refused without poisoning another room", () => {
  const { host, client, join } = fixture();
  try {
    const a = client("a"), b = client("b");
    a.send(join);
    b.send({ ...join, state: [NaN], room: "different" });
    assertEquals(b.received.at(-1)?.kind, "closed");
    assert(a.received.every((m) => m.kind === "waiting"));
  } finally {
    host.dispose();
  }
});
