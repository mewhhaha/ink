import {
  build_snapshot,
  encode_packet,
  NetworkSimulator,
} from "./networking.ts";
const packet = {
    sequence: 1,
    acknowledgement: 0,
    channel: 1,
    kind: "snapshot",
    payload: Array.from({ length: 100 }, (_, i) => i),
  },
  states = Array.from(
    { length: 1000 },
    (_, id) => ({ identity: { id, generation: 0 }, values: { x: id / 3 } }),
  ),
  schema = {
    id: "bench",
    fields: [{
      name: "x",
      kind: "number" as const,
      quantum: .01,
      authority: "server" as const,
      frequency: 1,
    }],
  };
Deno.bench("encode 100-value packet", () => {
  encode_packet(packet);
});
Deno.bench("build 1,000-entity snapshot", () => {
  build_snapshot(1, schema, states, null, new Set(), 1e9);
});
Deno.bench("simulate 1,000 packets", () => {
  const s = new NetworkSimulator({
    seed: 1,
    latency: 1,
    jitter: 1,
    loss: .1,
    duplication: .1,
    corruption: .01,
    bandwidth: 1e6,
    reorder: .1,
  });
  for (let i = 0; i < 1000; i++) s.send(0, new Uint8Array(64));
  s.receive(10);
});
