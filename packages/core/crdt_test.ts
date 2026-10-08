import { assertEquals, assertThrows } from "@std/assert";
import { CrdtDocument, type CrdtEntry, type Json } from "./crdt.ts";

const initial = {
  entities: { "1": { position: [0, 0, 0], name: "Box", color: [1, 1, 1, 1] } },
};

Deno.test("CRDT fields converge despite concurrent edits, reverse delivery and duplicates", () => {
  const a = new CrdtDocument("alice", initial),
    b = new CrdtDocument("bob", initial);
  const nextA = structuredClone(initial), nextB = structuredClone(initial);
  nextA.entities["1"].position[0] = 4;
  nextB.entities["1"].position[1] = 7;
  nextA.entities["1"].name = "Alice's name";
  nextB.entities["1"].name = "Bob's name";
  const opsA = a.change(initial, nextA, "Move X");
  const opsB = b.change(initial, nextB, "Move Y");
  a.merge([...opsB].reverse());
  b.merge([...opsA, ...opsA]);
  assertEquals(a.read(), b.read());
  assertEquals(a.read(), {
    entities: {
      "1": { position: [4, 7, 0], name: "Bob's name", color: [1, 1, 1, 1] },
    },
  });
  // Undo only Alice's surviving field; Bob's name and Y remain.
  b.merge(a.undo());
  assertEquals(a.read(), b.read());
  assertEquals((a.read() as typeof initial).entities["1"].position, [0, 7, 0]);
  assertEquals((a.read() as typeof initial).entities["1"].name, "Bob's name");
  b.merge(a.redo());
  assertEquals((a.read() as typeof initial).entities["1"].position, [4, 7, 0]);
});

Deno.test("CRDT tombstones prevent resurrection and undo preserves remote descendants", () => {
  const a = new CrdtDocument("zoe", initial),
    b = new CrdtDocument("alice", initial);
  const removed = a.change(initial, { entities: {} }, "Delete box");
  const edited = structuredClone(initial);
  edited.entities["1"].name = "still editing";
  const edit = b.change(initial, edited, "Rename");
  a.merge(edit);
  b.merge(removed);
  assertEquals(a.read(), { entities: {} });
  assertEquals(a.read(), b.read());
  b.merge(a.undo());
  assertEquals(a.read(), b.read());
  assertEquals(
    (a.read() as typeof initial).entities["1"].name,
    "still editing",
  );

  const empty = { entities: {} };
  const c = new CrdtDocument("carol", empty),
    d = new CrdtDocument("dave", empty);
  d.merge(c.change(empty, initial, "Create"));
  c.merge(d.change(initial, edited, "Rename remote box"));
  d.merge(c.undo());
  assertEquals(c.read(), d.read());
  assertEquals(
    (c.read() as typeof initial).entities["1"].name,
    "still editing",
  );
});

Deno.test("undo of a continuing drag restores the remote value observed mid-gesture", () => {
  const a = new CrdtDocument("alice", initial),
    b = new CrdtDocument("bob", initial);
  const moved = (x: number) => {
    const next = structuredClone(initial);
    next.entities["1"].position[0] = x;
    return next;
  };
  a.begin("Drag");
  b.merge(a.change(initial, moved(3), "Drag"));
  a.merge(b.change(moved(3), moved(8), "Remote move"));
  b.merge(a.change(moved(8), moved(12), "Drag"));
  a.commit();
  b.merge(a.undo());
  assertEquals((a.read() as typeof initial).entities["1"].position, [8, 0, 0]);
  assertEquals(a.read(), b.read());
});

Deno.test("CRDT drag transactions and cancellation merge remote fields; snapshots retain clocks", () => {
  const a = new CrdtDocument("alice", initial),
    b = new CrdtDocument("bob", initial);
  a.begin("Drag");
  let previous = structuredClone(initial);
  for (let x = 1; x <= 10; x++) {
    const next = structuredClone(previous);
    next.entities["1"].position[0] = x;
    b.merge(a.change(previous, next, "Drag"));
    previous = next;
  }
  const nextB = structuredClone(previous);
  nextB.entities["1"].position[1] = 8;
  a.merge(b.change(previous, nextB, "Move Y"));
  b.merge(a.cancel());
  assertEquals(a.history().undo, []);
  assertEquals((a.read() as typeof initial).entities["1"].position, [0, 8, 0]);
  const restored = new CrdtDocument("restored");
  restored.merge(a.entries());
  assertEquals(restored.read(), a.read());
  assertEquals(
    restored.change(restored.read(), { entities: {} }, "Remove")[0].clock >
      a.entries()[0].clock,
    true,
  );
  assertThrows(() =>
    a.merge([{
      path: [],
      actor: "bad",
      clock: NaN,
      node: { kind: "value", value: 0 },
    }])
  );
  const corrupt = structuredClone(
    a.entries().find((e) => e.node.kind === "value")!,
  ) as CrdtEntry;
  corrupt.node = { kind: "value", value: "conflict" as Json };
  assertThrows(() => a.merge([corrupt]), Error, "identity");
});
