import { assertEquals, assertThrows } from "@std/assert";
import {
  build_snapshot,
  encode_packet,
  fragment_message,
  handshake_compatibility,
  NetworkSimulator,
  parse_packet,
  Reassembler,
  ReliableQueue,
  rollback,
  sequence_newer,
} from "./networking.ts";
Deno.test("handshake mismatch is explicit", () =>
  assertEquals(
    handshake_compatibility({
      protocol: 1,
      engine: "a",
      game: "g",
      schema: "s",
      features: [],
      content: "c",
    }, {
      protocol: 2,
      engine: "a",
      game: "g",
      schema: "s",
      features: [],
      content: "c",
    }).type,
    "rejected",
  ));
Deno.test("sequence arithmetic wraps", () => {
  assertEquals(sequence_newer(0, 0xffffffff), true);
  assertEquals(sequence_newer(0xffffffff, 0), false);
});
Deno.test("malformed and oversized packets are rejected", () => {
  assertEquals(
    parse_packet(new TextEncoder().encode("{"), 10).type,
    "rejected",
  );
  assertThrows(() =>
    encode_packet({
      sequence: 0,
      acknowledgement: 0,
      channel: 0,
      kind: "x",
      payload: "long",
    }, 10)
  );
});
Deno.test("fragments reassemble through reordering and duplication", () => {
  const p = fragment_message(1, new Uint8Array([1, 2, 3, 4, 5]), 2),
    r = new Reassembler();
  r.push(p[2]);
  r.push(p[0]);
  r.push(p[0]);
  assertEquals([...r.push(p[1])!], [1, 2, 3, 4, 5]);
});
Deno.test("reliable queue is bounded and acknowledged", () => {
  const q = new ReliableQueue(1);
  q.enqueue(1, new Uint8Array([1]), 0);
  assertEquals(q.retransmissions(2, 1).length, 1);
  assertThrows(() => q.enqueue(2, new Uint8Array(), 2));
  q.acknowledge(1);
  assertEquals(q.size, 0);
});
Deno.test("snapshot quantization preserves identity generations", () => {
  const s = {
    id: "s",
    fields: [{
      name: "x",
      kind: "number" as const,
      quantum: .5,
      authority: "server" as const,
      frequency: 1,
    }],
  };
  const a = build_snapshot(
    1,
    s,
    [{
      identity: { id: 1, generation: 0 },
      values: { x: .7 },
      relevance: ["a"],
    }],
    null,
    new Set(["a"]),
    100,
  );
  assertEquals(a.entities[0].values.x, .5);
  assertEquals(
    build_snapshot(
      2,
      s,
      [{
        identity: { id: 1, generation: 1 },
        values: { x: .7 },
        relevance: ["a"],
      }],
      a,
      new Set(["a"]),
      100,
    ).entities.length,
    1,
  );
});
Deno.test("simulator reproduces impairment runs", () => {
  const o = {
    seed: 7,
    latency: 10,
    jitter: 4,
    loss: .2,
    duplication: .3,
    corruption: .1,
    bandwidth: 100,
    reorder: .5,
  };
  const run = () => {
    const s = new NetworkSimulator(o);
    for (let i = 0; i < 20; i++) s.send(i, new Uint8Array([i]));
    return s.receive(100).map((x) => [...x]);
  };
  assertEquals(run(), run());
});
Deno.test("rollback reproduces corrected checksums", () => {
  let value = 0;
  assertEquals(
    rollback(
      {
        restore: (x: number) => value = x,
        step: (i) => value += i.axes[0],
        checksum: () => String(value),
      },
      0,
      [{ tick: 1, axes: [2], buttons: 0 }],
      "2",
    ).type,
    "reproduced",
  );
});
