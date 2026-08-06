import { assertEquals, assertRejects } from "@std/assert";
import { parse_game_artifact } from "./artifact.ts";
import {
  DeterministicChannels,
  DeterministicRandomStreams,
} from "./determinism.ts";
import {
  capture_runtime_snapshot,
  parse_runtime_snapshot,
  restore_runtime_snapshot,
  serialize_runtime_snapshot,
} from "./snapshot.ts";

Deno.test("snapshot round trip restores guest random and channel state", async () => {
  const artifact = parse_game_artifact({
    guest_id: "snapshot-guest",
    artifact_digest: "artifact-1",
    schema_digest: "schema-1",
    wasm: new Uint8Array([1]),
    capabilities: [],
  });
  let guest_state = new Uint8Array([1, 2]);
  let channel_state = new Uint8Array([3]);
  const guest = {
    snapshot: () => guest_state.slice(),
    restore: (payload: Uint8Array) => {
      guest_state = payload.slice();
    },
  };
  const channels = new DeterministicChannels([{
    id: "physics",
    snapshot: () => channel_state.slice(),
    restore: (payload) => {
      channel_state = payload.slice();
    },
  }]);
  const random = new DeterministicRandomStreams(5n);
  random.stream("world").next_u64();
  const snapshot = await capture_runtime_snapshot(
    artifact,
    4,
    guest,
    random,
    channels,
  );
  const expected_random = random.stream("world").next_u64();
  guest_state = new Uint8Array([9]);
  channel_state = new Uint8Array([8]);

  const parsed = await parse_runtime_snapshot(
    serialize_runtime_snapshot(snapshot),
    artifact,
  );
  await restore_runtime_snapshot(parsed, guest, random, channels);
  assertEquals(guest_state, new Uint8Array([1, 2]));
  assertEquals(channel_state, new Uint8Array([3]));
  assertEquals(random.stream("world").next_u64(), expected_random);
});

Deno.test("snapshot corruption reports the supplied and expected checksums", async () => {
  const artifact = parse_game_artifact({
    guest_id: "snapshot-guest",
    artifact_digest: "artifact-1",
    schema_digest: "schema-1",
    wasm: new Uint8Array([1]),
    capabilities: [],
  });
  const snapshot = await capture_runtime_snapshot(
    artifact,
    0,
    { snapshot: () => new Uint8Array([1]), restore: () => {} },
    new DeterministicRandomStreams(0n),
    new DeterministicChannels([]),
  );
  const corrupted = JSON.stringify({ ...snapshot, guest_state: "Ag==" });
  await assertRejects(
    () => parse_runtime_snapshot(corrupted, artifact),
    Error,
    `runtime snapshot checksum ${
      JSON.stringify(snapshot.checksum)
    } does not match`,
  );
});
