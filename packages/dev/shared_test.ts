import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { EventEmitter } from "node:events";
import type { ViteDevServer, WebSocketClient } from "vite";
import {
  CrdtDocument,
  readSharedData,
  sharedData,
  type SharedReceive,
  type SharedSend,
} from "@ink/core";
import { SharedHost } from "./shared_host.ts";
import type { ResolvedProject } from "./node.ts";

Deno.test("shared relay persists clocks and id reservations across restart, rejects spoofed authors, and merges source edits", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ink-shared-" });
  const project = {
    inkDir: join(dir, ".ink"),
    scenesDir: join(dir, "scenes"),
  } as ResolvedProject;
  const makeHost = () => {
    const emitter = new EventEmitter();
    return new SharedHost(
      {
        ws: { on: emitter.on.bind(emitter), off: emitter.off.bind(emitter) },
      } as unknown as ViteDevServer,
      project,
      async (file, text) => {
        await Deno.mkdir(dirname(file), { recursive: true });
        await Deno.writeTextFile(file, text);
      },
    );
  };
  let host = makeHost();
  const client = (channel: string) => {
    const received: SharedReceive[] = [];
    const socket = {
      socket: new EventEmitter(),
      send: (data: { data: { message: SharedReceive } }) =>
        received.push(data.data.message),
    } as unknown as WebSocketClient;
    return {
      socket,
      received,
      send(message: SharedSend) {
        host.receive({ channel, message }, socket);
      },
      async wait<K extends SharedReceive["kind"]>(
        kind: K,
      ): Promise<Extract<SharedReceive, { kind: K }>> {
        const deadline = performance.now() + 3000;
        while (performance.now() < deadline) {
          const index = received.findIndex((m) => m.kind === kind);
          if (index >= 0) {
            return received.splice(index, 1)[0] as Extract<
              SharedReceive,
              { kind: K }
            >;
          }
          await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error(`missing ${kind}: ${JSON.stringify(received)}`);
      },
    };
  };
  const scene = {
    ink: 1 as const,
    entities: [{
      id: 1,
      name: "Box",
      components: { transform: { position: [0, 0, 0] } },
    }],
  };
  const joinMessage: SharedSend = {
    kind: "join",
    name: "Alice",
    scene: "main",
    snapshot: scene,
    comments: [],
  };
  try {
    const a = client("a"), b = client("b");
    a.send(joinMessage);
    const first = await a.wait("ready");
    const doc = new CrdtDocument(first.actor);
    doc.merge(first.entries);
    const next = readSharedData(doc.read());
    next.scene.entities.push({
      id: first.range[0],
      name: "Created",
      components: {},
    });
    const entries = doc.change(
      doc.read(),
      sharedData(next.scene, []),
      "Create",
    );
    a.send({ kind: "ops", request: "create", entries });
    a.send({ kind: "flush", request: "save" });
    const ack = await a.wait("ack");
    assert(ack.requests.includes("create") && ack.requests.includes("save"));
    b.send({ ...joinMessage, name: "Bob" });
    const second = await b.wait("ready");
    assert(second.range[0] >= first.range[1]);
    b.send({ kind: "ops", request: "spoof", entries });
    assert((await b.wait("closed")).reason.includes("author"));
    await host.external({
      ...next.scene,
      entities: next.scene.entities.map((e) =>
        e.id === 1 ? { ...e, name: "From disk" } : e
      ),
    });
    await host.dispose();
    host = makeHost();
    const c = client("c");
    c.send(joinMessage);
    const restored = await c.wait("ready");
    assert(
      restored.range[0] >= second.range[1],
      "unused reserved ids are never reissued after restart",
    );
    const loaded = new CrdtDocument(restored.actor);
    loaded.merge(restored.entries);
    assertEquals(
      readSharedData(loaded.read()).scene.entities.map((e) => e.name),
      ["From disk", "Created"],
    );
    const other = client("other");
    other.send({ ...joinMessage, scene: "other" });
    assert((await other.wait("closed")).reason.includes("main"));
  } finally {
    await host.dispose();
    await Deno.remove(dir, { recursive: true });
  }
});
