import { assertEquals } from "@std/assert";
import { createGameCompiler } from "@ink/blot/compiler";
import { loadGame } from "@ink/blot";
import {
  axis,
  button,
  defineSchema,
  f32,
  idleInput,
  type SceneFile,
  u32,
} from "@ink/schema";
import { Session } from "@ink/core";
import { Player } from "./runtime.ts";

Deno.test("shipping player and editor produce identical states and restart", async () => {
  const root = await Deno.makeTempDir({ prefix: "ink-player-test-" });
  const catalog = { assets: {} };
  const schema = defineSchema({
    resources: {
      motion: { x: f32(), time: f32(), jumps: u32(), starts: u32() },
    },
    actions: { move: axis(["KeyA"], ["KeyD"]), jump: button("Space") },
  });
  const scene: SceneFile = { ink: 1, entities: [] };
  await Deno.writeTextFile(
    `${root}/main.blot`,
    `import * as s from "./schema.gen"
const begin = fn (_input: s.Input) => fn (world: s.World) => do:
  world.resources.motion.starts := self + 1
  return world
const update = fn (input: s.Input) => fn (world: s.World) => do:
  world.resources.motion.x := self + input.actions.move * input.dt
  world.resources.motion.time := input.time
  if input.actions.jump.pressed:
    world.resources.motion.jumps := self + 1
  return world
entry const start = fn (lanes: Array F32) -> Array F32 => s.run begin lanes
entry const step = fn (lanes: Array F32) -> Array F32 => s.run update lanes
`,
  );
  const compiler = await createGameCompiler({
    entry: `${root}/main.blot`,
    schema,
    catalog,
  });
  const build = await compiler.build();
  if (!build.ok) throw new Error(JSON.stringify(build.diagnostics));
  const player = new Player(
    schema,
    catalog,
    await loadGame(build.bytes, schema),
    scene,
  );
  const session = new Session({ schema, catalog, scene });
  session.setGame(await loadGame(build.bytes, schema), { revision: 1 });
  session.play();
  try {
    for (let tick = 0; tick < 180; tick++) {
      const input = idleInput(schema, tick);
      input.actions.move = tick < 100 ? 1 : -1;
      input.actions.jump = {
        down: tick >= 30 && tick < 45,
        pressed: tick === 30,
        released: tick === 45,
      };
      player.step(input);
      session.stepFrame(input);
      assertEquals(player.state, session.state, `tick ${tick + 1}`);
    }
    player.restart();
    session.restart();
    assertEquals(player.state, session.state);
  } finally {
    player.dispose();
    session.dispose();
    await compiler.dispose();
    await Deno.remove(root, { recursive: true });
  }
});
