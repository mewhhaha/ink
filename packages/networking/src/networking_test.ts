import { assertEquals, assertThrows } from "@std/assert";
import {
  build_snapshot,
  correct_prediction,
  define_replication_schema,
  encode_packet,
  fragment_message,
  handshake_compatibility,
  interpolate_samples,
  NetworkSession,
  NetworkSimulator,
  parse_packet,
  Reassembler,
  ReliableQueue,
  rollback,
  sequence_newer,
  synchronize_time,
  websocket_transport,
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
Deno.test("handshake features are compatible independent of declaration order", () => {
  const expected = {
    protocol: 1,
    engine: "a",
    game: "g",
    schema: "s",
    features: ["rollback", "voice"],
    content: "c",
  };
  assertEquals(
    handshake_compatibility(expected, {
      ...expected,
      features: ["voice", "rollback"],
    }),
    { type: "compatible" },
  );
  assertEquals(
    handshake_compatibility(expected, { ...expected, features: ["rollback"] })
      .type,
    "rejected",
  );
});
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
  assertEquals(
    parse_packet(new Uint8Array([0xff])).type,
    "rejected",
  );
  assertEquals(
    parse_packet(
      new TextEncoder().encode(
        JSON.stringify({
          sequence: 0,
          acknowledgement: 0,
          channel: 0,
          kind: "missing-payload",
        }),
      ),
    ).type,
    "rejected",
  );
  assertThrows(
    () =>
      encode_packet({
        sequence: 0,
        acknowledgement: 0,
        channel: 0,
        kind: "",
        payload: null,
      }),
    Error,
    "packet kind cannot be empty",
  );
  assertThrows(
    () =>
      encode_packet({
        sequence: 0,
        acknowledgement: 0,
        channel: 0,
        kind: "state",
        payload: Number.NaN as never,
      }),
    Error,
    "packet payload number NaN must be finite",
  );
});
Deno.test("transport adapters enforce limits and detach sent bytes", () => {
  const sent: Uint8Array[] = [];
  const transport = websocket_transport({
    send: (bytes) => sent.push(bytes),
    close: () => {},
  }, 2);
  const payload = new Uint8Array([1, 2]);
  transport.send(0, payload);
  payload[0] = 9;
  assertEquals([...sent[0]], [1, 2]);
  assertThrows(
    () => transport.send(0, new Uint8Array(3)),
    Error,
    "WebSocket payload length 3 exceeds 2",
  );
});
Deno.test("network sessions acknowledge the newest received sequence", () => {
  const sent: Uint8Array[] = [];
  const capabilities = {
    guarantees: ["reliable_ordered" as const],
    maximum_message_bytes: 1024,
  };
  const session = new NetworkSession({
    capabilities,
    send: (_channel, bytes) => sent.push(bytes),
    close: () => {},
  });
  const packet = (sequence: number) =>
    encode_packet({
      sequence,
      acknowledgement: 0,
      channel: 0,
      kind: "state",
      payload: null,
    });
  session.receive(packet(10));
  session.receive(packet(9));
  capabilities.maximum_message_bytes = 1;
  session.keepalive(11);

  const keepalive = parse_packet(sent[0]);
  if (keepalive.type !== "ready") throw new Error(keepalive.reason);
  assertEquals(keepalive.packet.acknowledgement, 10);
});
Deno.test("fragments reassemble through reordering and duplication", () => {
  const p = fragment_message(1, new Uint8Array([1, 2, 3, 4, 5]), 2),
    r = new Reassembler();
  r.push(p[2]);
  r.push(p[0]);
  r.push(p[0]);
  assertEquals([...r.push(p[1])!], [1, 2, 3, 4, 5]);
});
Deno.test("reassembly rejects conflicting metadata and bounded message growth", () => {
  const counts = new Reassembler();
  counts.push({ message: 1, index: 0, count: 2, bytes: new Uint8Array([1]) });
  assertThrows(
    () =>
      counts.push({
        message: 1,
        index: 1,
        count: 3,
        bytes: new Uint8Array([2]),
      }),
    Error,
    "fragment count changed from 2 to 3",
  );

  const bytes = new Reassembler(1, 2);
  bytes.push({ message: 2, index: 0, count: 2, bytes: new Uint8Array([1, 2]) });
  assertThrows(
    () =>
      bytes.push({
        message: 2,
        index: 1,
        count: 2,
        bytes: new Uint8Array([3]),
      }),
    Error,
    "message 2 length exceeds 2 bytes",
  );
  assertThrows(
    () => new Reassembler(0),
    Error,
    "maximum reassembly messages 0 must be a positive safe integer",
  );
});
Deno.test("reliable queue is bounded and acknowledged", () => {
  const q = new ReliableQueue(1);
  q.enqueue(1, new Uint8Array([1]), 0);
  assertEquals(q.retransmissions(2, 1).length, 1);
  assertThrows(() => q.enqueue(2, new Uint8Array(), 2));
  q.acknowledge(1);
  assertEquals(q.size, 0);
});
Deno.test("reliable queue rejects ambiguous sequences and times", () => {
  const queue = new ReliableQueue(2);
  queue.enqueue(1, new Uint8Array([1]), 2);
  assertThrows(
    () => queue.enqueue(1, new Uint8Array([2]), 1),
    Error,
    "reliable sequence 1 is already pending",
  );
  assertThrows(
    () => queue.retransmissions(Number.NaN, 1),
    Error,
    "retransmission time NaN must be finite and nonnegative",
  );
  assertThrows(
    () => queue.retransmissions(0, 1),
    Error,
    "retransmission time 0 precedes sequence 1 send time 2",
  );
});
Deno.test("snapshot quantization preserves identity generations", () => {
  const s = define_replication_schema("s", [{
    name: "x",
    kind: "number" as const,
    quantum: .5,
    authority: "server" as const,
    frequency: 1,
  }]);
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
Deno.test("snapshot schemas enforce frequency, baselines, and finite values", () => {
  const schema = define_replication_schema("motion", [{
    name: "x",
    kind: "number",
    authority: "server",
    frequency: 2,
  }]);
  const state = [{
    identity: { id: 1, generation: 0 },
    values: { x: 4 },
  }];

  assertEquals(build_snapshot(1, schema, state, null, new Set(), 1000), {
    schema: "motion",
    tick: 1,
    baseline: null,
    entities: [{ identity: { id: 1, generation: 0 }, values: {} }],
  });
  const first = build_snapshot(2, schema, state, null, new Set(), 1000);
  assertEquals(first.entities[0].values, { x: 4 });
  assertThrows(
    () => build_snapshot(2, schema, state, first, new Set(), 1000),
    Error,
    "snapshot baseline tick 2 must precede tick 2",
  );
  assertThrows(
    () =>
      build_snapshot(
        3,
        schema,
        [{ identity: { id: 1, generation: 0 }, values: { x: Number.NaN } }],
        null,
        new Set(),
        1000,
      ),
    Error,
    "field x must be finite, received NaN",
  );
});

Deno.test("snapshot budgeting skips oversized entities without starving later ones", () => {
  const schema = define_replication_schema("names", [{
    name: "name",
    kind: "string",
    authority: "server",
    frequency: 1,
  }]);
  const small = {
    identity: { id: 2, generation: 0 },
    values: { name: "b" },
  };
  const small_size = new TextEncoder().encode(JSON.stringify(small)).length;
  const snapshot = build_snapshot(
    1,
    schema,
    [{
      identity: { id: 1, generation: 0 },
      values: { name: "far too large" },
    }, small],
    null,
    new Set(),
    small_size,
  );
  assertEquals(snapshot.entities, [small]);
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
Deno.test("simulator rejects impossible impairment configuration", () => {
  assertThrows(
    () =>
      new NetworkSimulator({
        seed: 1,
        latency: 0,
        jitter: 0,
        loss: 1.1,
        duplication: 0,
        corruption: 0,
        bandwidth: 1,
        reorder: 0,
      }),
    Error,
    "network simulation loss 1.1 must be in 0..1",
  );
});
Deno.test("network timing rejects non-finite clocks and corrections", () => {
  assertThrows(
    () =>
      synchronize_time({
        sent_at: 0,
        received_at: 1,
        remote_at: Number.POSITIVE_INFINITY,
      }),
    Error,
    "time sample remote_at Infinity must be finite and nonnegative",
  );
  assertThrows(
    () =>
      interpolate_samples(
        { time: 0, value: 0 },
        { time: 1, value: 1 },
        Number.NaN,
        () => 0,
      ),
    Error,
    "requested interpolation time NaN must be finite and nonnegative",
  );
  assertThrows(
    () =>
      correct_prediction(
        {
          clone: (state: number) => state,
          step: (state: number) => state,
          error: () => Number.NaN,
          reconcile: (_predicted: number, authoritative: number) =>
            authoritative,
        },
        0,
        1,
        [],
        0,
        1,
      ),
    Error,
    "prediction correction NaN must be finite and nonnegative",
  );
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
