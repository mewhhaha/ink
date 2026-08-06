import { parse_game_artifact } from "./artifact.ts";
import {
  DeterministicChannels,
  DeterministicRandomStreams,
} from "./determinism.ts";
import type { Block } from "./graph.ts";
import { resolve_runtime_graph } from "./graph.ts";
import { capture_runtime_snapshot } from "./snapshot.ts";

const artifact = parse_game_artifact({
  guest_id: "benchmark",
  artifact_digest: "artifact-1",
  schema_digest: "schema-1",
  wasm: new Uint8Array([1]),
  capabilities: [],
});
const blocks: Block[] = Array.from({ length: 1_000 }, (_, index) => ({
  id: `block-${index}`,
  dependencies: index === 0 ? [] : [`block-${index - 1}`],
  capabilities: [],
  acquire: () => ({}),
}));

Deno.bench("resolve one thousand runtime blocks", () => {
  resolve_runtime_graph({ artifact, blocks });
});

const snapshot_state = new Uint8Array(4_096);
const snapshot_random = new DeterministicRandomStreams(1n);
snapshot_random.stream("benchmark").next_u64();
const no_channels = new DeterministicChannels([]);

Deno.bench("capture four kilobyte deterministic snapshot", async () => {
  await capture_runtime_snapshot(
    artifact,
    1,
    { snapshot: () => snapshot_state, restore: () => {} },
    snapshot_random,
    no_channels,
  );
});
