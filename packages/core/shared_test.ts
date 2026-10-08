import { assertEquals } from "@std/assert";
import { defineSchema, standard } from "@ink/schema";
import { CrdtDocument, type CrdtEntry } from "./crdt.ts";
import { readSharedData, sharedData } from "./shared_document.ts";
import { SharedSession } from "./shared_session.ts";
import { Session } from "./session.ts";

Deno.test("shared sessions preserve independent edits, local undo, concurrent ids, transactions and replies", async () => {
  const schema = defineSchema({
    components: { transform: standard.transform },
  });
  const scene = {
    ink: 1 as const,
    entities: [{ id: 1, name: "Box", components: { transform: {} } }],
  };
  const sessions = [0, 1].map(() =>
    new Session({ schema, scene, catalog: { assets: {} } })
  );
  const canonical = sessions[0].toScene();
  const initial = new CrdtDocument("server", sharedData(canonical, []))
    .entries();
  const pending: { peer: number; request: string; entries: CrdtEntry[] }[] = [];
  const peers = sessions.map((session, peer) =>
    new SharedSession(session, {
      send(message) {
        if (message.kind === "ops") {
          pending.push({
            peer,
            request: message.request,
            entries: message.entries,
          });
        }
        if (message.kind === "flush") {
          peers[peer].receive({ kind: "ack", requests: [message.request] });
        }
      },
      close() {},
    })
  );
  const deliver = () => {
    for (const op of pending.splice(0).reverse()) {
      for (const peer of peers) {
        peer.receive({ kind: "ops", entries: op.entries });
      }
      peers[op.peer].receive({ kind: "ack", requests: [op.request] });
    }
  };
  for (const [i, peer] of peers.entries()) {
    peer.receive({
      kind: "ready",
      actor: `peer-${i}`,
      entries: initial,
      range: [1000 + i * 4096, 5096 + i * 4096],
      peers: [],
    });
  }
  const position = (i: number) =>
    sessions[i].world.entities.find((e) => e.id === 1)!.components.transform
      .position;
  try {
    sessions[0].edit("Move X", (w) => {
      (w.entities[0].components.transform.position as number[])[0] = 4;
    });
    sessions[1].edit("Move Y", (w) => {
      (w.entities[0].components.transform.position as number[])[1] = 8;
    });
    deliver();
    assertEquals(position(0), [4, 8, 0]);
    assertEquals(sessions[0].state, sessions[1].state);
    assertEquals(sessions[0].history().undo, ["Move X"]);
    sessions[0].undo();
    deliver();
    assertEquals(position(0), [0, 8, 0]);
    sessions[0].redo();
    deliver();
    const a = sessions[0].createEntity({
      name: "Alice's box",
      components: { transform: {} },
    });
    const b = sessions[1].createEntity({
      name: "Bob's box",
      components: { transform: {} },
    });
    deliver();
    assertEquals(a === b, false);
    assertEquals(sessions[0].state, sessions[1].state);
    assertEquals(sessions[0].selection, [a]);
    assertEquals(sessions[1].selection, [b]);
    const drag = sessions[0].begin("Drag");
    drag.update((w) => {
      (w.entities[0].components.transform.position as number[])[0] = 10;
    });
    deliver();
    sessions[1].edit("Move Y", (w) => {
      (w.entities[0].components.transform.position as number[])[1] = 12;
    });
    deliver();
    drag.cancel();
    deliver();
    assertEquals(position(0), [4, 12, 0]);
    const comment = sessions[0].addComment({
      text: "Fix this",
      author: "Alice",
      anchor: { mode: "edit", tick: 0 },
    });
    deliver();
    for (const [i, s] of sessions.entries()) {
      s.replyToComment(comment.id, {
        author: `Author ${i}`,
        text: `Reply ${i}`,
        created: "2026-10-08T00:00:00Z",
      });
    }
    deliver();
    assertEquals(sessions[0].comments, sessions[1].comments);
    assertEquals(sessions[0].comments[0].replies?.length, 2);
    const interrupted = sessions[0].begin("Interrupted drag");
    interrupted.update((w) => {
      (w.entities[0].components.transform.position as number[])[0] = 20;
    });
    deliver();
    await Promise.all(peers.map((p) => p.flush()));
    peers[0].receive({ kind: "closed", reason: "Disconnected" });
    const disconnected = sessions[0].state.slice();
    interrupted.cancel();
    assertEquals(sessions[0].state, disconnected);
    assertEquals(sessions[0].edit("Offline", () => {}), false);
  } finally {
    sessions.forEach((s) => s.dispose());
  }
});

Deno.test("concurrent reparenting materializes without cycles and does not drop entities", () => {
  const scene = {
    ink: 1 as const,
    entities: [{ id: 1, parent: 2, components: {} }, {
      id: 2,
      parent: 1,
      components: {},
    }],
  };
  const { scene: read } = readSharedData(sharedData(scene, []));
  assertEquals(read.entities.map((e) => [e.id, e.parent]), [[1, undefined], [
    2,
    1,
  ]]);
});
