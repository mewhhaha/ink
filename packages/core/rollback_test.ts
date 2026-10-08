import { assert, assertEquals, assertThrows } from "@std/assert";
import { createGameCompiler } from "@ink/blot/compiler";
import { loadGame } from "@ink/blot";
import {
  axis,
  button,
  decodeInput,
  decodeWorld,
  defineSchema,
  emptyWorld,
  encodeInput,
  encodeWorld,
  f32,
  idleInput,
  type InputModel,
  u32,
} from "@ink/schema";
import { NetworkError, Rollback } from "./rollback.ts";

const schema = defineSchema({
  resources: { motion: { x: f32(), y: f32(), presses: u32(), random: f32() } },
  actions: { move: axis(["KeyA"], ["KeyD"]), jump: button("Space") },
});

const controls = (peer: number, tick: number) => {
  const input = idleInput(schema, tick);
  input.actions.move = ((Math.floor(tick / (11 + peer * 7)) + peer) % 3) - 1;
  input.actions.jump = {
    down: tick % 29 < 8,
    pressed: tick % 29 === peer,
    released: tick % 29 === 8,
  };
  input.pointer.delta = [tick % 5, 0];
  return input;
};

Deno.test("player inputs round trip and reject malformed peer packets", () => {
  const input = idleInput(schema, 6, 0.25);
  input.players = [0, 4].map((id) => ({ ...controls(id, 6), id }));
  const decoded = decodeInput(schema, encodeInput(schema, input));
  assertEquals(decoded.players?.map((p) => p.id), [0, 4]);
  assertEquals(decoded.players?.[1].actions, input.players[1].actions);
  assertThrows(() =>
    encodeInput(schema, { ...input, players: [...input.players!].reverse() })
  );
  const invalid = encodeInput(schema, input);
  invalid[0] = NaN;
  assertThrows(() => decodeInput(schema, invalid));
  assertThrows(() => decodeInput(schema, invalid.slice(1)));
});

Deno.test("Wasm rollback converges with 100 ms delay, jitter, reorder, duplicates and bounded history", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ink-rollback-" });
  await Deno.writeTextFile(
    `${dir}/main.blot`,
    `import * as s from "./schema.gen"
const update = fn (input: s.Input) => fn (world: s.World) => do:
  let a = s.player_input input 0
  let b = s.player_input input 1
  world.resources.motion.x := self + a.actions.move * input.dt
  world.resources.motion.y := self + b.actions.move * input.dt
  if a.actions.jump.pressed:
    world.resources.motion.presses := self + 1
  if b.actions.jump.pressed:
    world.resources.motion.presses := self + 1
  use random <- s.random ()
  world.resources.motion.random := random
  return world
entry const step = fn (lanes: Array F32) -> Array F32 => s.run update lanes
`,
  );
  const compiler = await createGameCompiler({
    entry: `${dir}/main.blot`,
    schema,
    catalog: { assets: {} },
  });
  const games: Awaited<ReturnType<typeof loadGame>>[] = [];
  try {
    const build = await compiler.build();
    if (!build.ok) throw new Error(JSON.stringify(build.diagnostics));
    for (let i = 0; i < 3; i++) games.push(await loadGame(build.bytes, schema));
    const state = encodeWorld(schema, emptyWorld(schema, 42));
    const common = { schema, state, peers: [0, 1], capacity: 64 };
    const reference = new Rollback({
      ...common,
      game: games[2],
      mode: "lockstep",
    });
    const pair = [0, 1].map((id) =>
      new Rollback({
        ...common,
        game: games[id],
        onConfirm(tick, hash) {
          pair[1 - id].receiveHash(id, tick, hash);
        },
      })
    );
    const queue: { at: number; peer: number; input: InputModel }[] = [];
    const deliver = (at: number) => {
      // Reverse order deliberately: transport need not deliver inputs in order.
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].at <= at) {
          const { peer, input } = queue.splice(i, 1)[0];
          pair[1 - peer].submit(peer, input);
          if (input.tick % 17 === 0) pair[1 - peer].submit(peer, input);
        }
      }
    };
    let pressed = 0;
    for (let tick = 0; tick < 300; tick++) {
      deliver(tick);
      for (const peer of [0, 1]) {
        const input = controls(peer, tick);
        if ((input.actions.jump as { pressed: boolean }).pressed) pressed++;
        reference.submit(peer, input);
        pair[peer].submit(peer, input);
        queue.push({ at: tick + 6 + (tick % 5 - 2), peer, input });
      }
      assert(reference.advance());
      for (const client of pair) assert(client.advance());
    }
    deliver(Infinity);
    for (const client of pair) {
      assertEquals(client.state, reference.state);
      assertEquals(client.confirmed, 300);
      assert(client.rollbacks > 20);
      assert(
        client.maxRollback >= 6,
        "corrected frames include the 100 ms window",
      );
      assert(client.first >= 220, "history is bounded");
      assertEquals(client.snapshot(280), reference.snapshot(280));
    }
    assertEquals(
      decodeWorld(schema, pair[0].state).resources.motion.presses,
      pressed,
    );
    assertThrows(
      () => pair[0].submit(1, controls(1, 0)),
      NetworkError,
      "older",
    );
    assertThrows(
      () => pair[0].submit(9, controls(1, 300)),
      NetworkError,
      "unknown",
    );
    const conflict = controls(1, 299);
    conflict.actions.move = 10;
    assertThrows(() => pair[0].submit(1, conflict), NetworkError, "changed");
    assertThrows(
      () => pair[0].receiveHash(1, 300, "deadbeef"),
      NetworkError,
      "desync",
    );
    assertEquals(reference.advance(), false, "lockstep waits for both players");
    for (let i = 0; i < pair[0].maxPrediction; i++) assert(pair[0].advance());
    assertEquals(
      pair[0].advance(),
      false,
      "rollback bounds prediction when a peer stalls",
    );
  } finally {
    for (const game of games) game.dispose();
    await compiler.dispose();
    await Deno.remove(dir, { recursive: true });
  }
});
