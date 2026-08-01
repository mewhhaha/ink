import { assertEquals, assertRejects } from "@std/assert";
import { complete_scene_scenario, run_game_program } from "./game_effects.ts";
import {
  create_headless_session,
  type HeadlessSession,
} from "./headless_session.ts";
import {
  load_scene_explorer,
  load_scene_explorer_artifact,
} from "./load_scene_explorer.ts";

Deno.test("the semantic contract exposes every playable beacon", async () => {
  const session = await load_test_session();
  const observation = session.observe();

  assertEquals(observation.regions.map((region) => region.label), [
    "Amber beacon",
    "Cyan beacon",
    "Violet beacon",
  ]);
  assertEquals(observation.actions.map((action) => action.id), [
    "focus:beacon-0",
    "activate:beacon-0",
    "focus:beacon-1",
    "activate:beacon-1",
    "focus:beacon-2",
    "activate:beacon-2",
    "toggle_projection",
  ]);
  session.close();
});

Deno.test("an effect-driven agent can complete the scene", async () => {
  const session = await load_test_session();
  const observation = await run_game_program(
    complete_scene_scenario(),
    session,
  );

  assertEquals(observation.outcome, "won");
  assertEquals(observation.status.value, "3 of 3 beacons lit");
  assertEquals(observation.regions.every((region) => region.pressed), true);
  assertEquals(
    session.trace().map((event) => event.type),
    ["initialized", "reset", "step", "step", "step"],
  );
  session.close();
});

Deno.test("a valid save restores state and an invalid save leaves it unchanged", async () => {
  const session = await load_test_session();
  await session.step({ type: "activate", target: 0 });
  const saved = await session.save();
  await session.step({ type: "activate", target: 1 });
  await session.load(saved);

  assertEquals(session.observe().status.value, "1 of 3 beacons lit");
  const corrupted = JSON.stringify({ ...JSON.parse(saved), state: "7" });
  await assertRejects(() => session.load(corrupted), Error, "checksum");
  assertEquals(session.observe().status.value, "1 of 3 beacons lit");
  session.close();
});

Deno.test("a replay reproduces its observation digests", async () => {
  const session = await load_test_session();
  await session.step({ type: "activate", target: 0 });
  await session.step({ type: "toggle_projection" });
  await session.step({ type: "activate", target: 2 });
  const replay = session.finish_replay();

  const observation = await session.replay(replay);
  assertEquals(observation.projection, "orthographic");
  assertEquals(observation.status.value, "2 of 3 beacons lit");
  session.close();
});

Deno.test("a compatible hot reload preserves guest state", async () => {
  const [wasm_bytes, manifest_source] = await read_test_artifact();
  const first = await load_scene_explorer_artifact(wasm_bytes, manifest_source);
  const session = await create_headless_session(first.guest, first.context);
  await session.step({ type: "activate", target: 1 });
  const replacement = await load_scene_explorer_artifact(
    wasm_bytes,
    manifest_source,
  );

  const reloaded = await session.reload(replacement.guest, {
    ...replacement.context,
    artifact_digest: "replacement-artifact",
  });
  assertEquals(reloaded.preserved, true);
  assertEquals(reloaded.observation.status.value, "1 of 3 beacons lit");
  session.close();
});

Deno.test("concurrent steps are committed in submission order", async () => {
  const session = await load_test_session();

  const observations = await Promise.all([
    session.step({ type: "activate", target: 0 }),
    session.step({ type: "activate", target: 1 }),
  ]);

  assertEquals(observations.map((observation) => observation.sequence), [1, 2]);
  assertEquals(session.observe().status.value, "2 of 3 beacons lit");
  assertEquals(
    session.finish_replay().steps.map((step) => step.sequence),
    [1, 2],
  );
  session.close();
});

Deno.test("a divergent replay leaves the current session unchanged", async () => {
  const session = await load_test_session();
  await session.step({ type: "activate", target: 2 });
  const replay = session.finish_replay();
  const divergent = {
    ...replay,
    steps: replay.steps.map((step) => ({
      ...step,
      observation_digest: "not-the-recorded-observation",
    })),
  };

  await assertRejects(() => session.replay(divergent), Error, "diverged");

  assertEquals(session.observe().status.value, "1 of 3 beacons lit");
  assertEquals(session.finish_replay(), replay);
  session.close();
});

async function load_test_session(): Promise<HeadlessSession> {
  const [wasm_bytes, manifest_source] = await read_test_artifact();
  return await load_scene_explorer(wasm_bytes, manifest_source);
}

async function read_test_artifact(): Promise<readonly [Uint8Array, string]> {
  const [wasm_bytes, manifest_source] = await Promise.all([
    Deno.readFile(new URL("../generated/scene_explorer.wasm", import.meta.url)),
    Deno.readTextFile(
      new URL("../generated/scene_explorer.wasm.json", import.meta.url),
    ),
  ]);
  return [wasm_bytes, manifest_source];
}
