/** Plays the Godot example headlessly: the platforms, and the physics scene. */
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createGameCompiler } from "@ink/blot/compiler";
import { loadGame } from "@ink/blot";
import {
  decodeWorld,
  encodeWorld,
  idleInput,
  type InputModel,
  type SceneFile,
  sceneToWorld,
  type WorldModel,
} from "@ink/schema";
import { loadSchema } from "@ink/dev/node";
import { scanAssets } from "@ink/dev/catalog";

const root = fromFileUrl(new URL(".", import.meta.url));
const schema = await loadSchema(`${root}schema.ts`, Date.now());
const catalog = await scanAssets(`${root}assets`);
const compiler = await createGameCompiler({
  entry: `${root}game/main.blot`,
  schema,
  catalog,
});
const build = await compiler.build();
assert(build.ok, "game compiles");
const game = await loadGame(build.bytes, schema);

async function start(
  scene: string,
  edit?: (file: SceneFile) => void,
) {
  const file: SceneFile = JSON.parse(
    await Deno.readTextFile(`${root}scenes/${scene}.scene.json`),
  );
  edit?.(file);
  let state = encodeWorld(schema, sceneToWorld(schema, file, catalog).world);
  const first = state[1];
  state = game.start(state, idleInput(schema, first, 0)).state;
  state[1] = first;
  let tick = first;
  return {
    world: (): WorldModel => decodeWorld(schema, state),
    step(count: number, change?: (input: InputModel, i: number) => void) {
      for (let i = 0; i < count; i++) {
        const input = {
          ...idleInput(schema, tick, 1 / 60),
          time: (tick - first) / 60,
        };
        change?.(input, i);
        state = game.step(state, input).state;
        state[1] = ++tick;
      }
    },
  };
}

const named = (world: WorldModel, name: string) =>
  world.entities.find((e) =>
    name === "Player" ? e.components.player : e.components.mover
  )!;

const at = (e: { components: Record<string, unknown> }) =>
  (e.components.transform as { position: number[] }).position;

Deno.test("the player stands on the moving platform and is carried by it", async () => {
  const play = await start("main", (file) => {
    const player = file.entities.find((e) => e.name === "Player")!;
    // Start on the moving platform, which begins at (9, 1.75, -7).
    (player.components.transform as { position: number[] }).position = [
      9,
      2.2,
      -6,
    ];
  });
  play.step(30);
  const before = at(named(play.world(), "Player"));
  play.step(90);
  const world = play.world();
  const after = at(named(world, "Player"));
  const platform = at(named(world, "Moving platform"));
  assert(
    Math.abs(after[2] - platform[2]) < 1.2,
    `still on the platform: player z=${after[2]} platform z=${platform[2]}`,
  );
  assert(Math.abs(after[2] - before[2]) > 1, "and it moved with it");
  assertEquals(
    (named(world, "Player").components.character as { grounded: boolean })
      .grounded,
    true,
  );
});

Deno.test("the physics scene's stacks stand until they are hit", async () => {
  const play = await start("physics");
  play.step(300);
  const world = play.world();
  // The tower of ten crates stood at x = -6, z = -3.
  const tower = world.entities.filter((e) =>
    e.components.body && Math.abs(at(e)[0] + 6) < 0.5 &&
    Math.abs(at(e)[2] + 3) < 0.5
  );
  assertEquals(tower.length, 10);
  for (const crate of tower) {
    assert(
      Math.abs(at(crate)[0] + 6) < 0.15 && Math.abs(at(crate)[2] + 3) < 0.15,
      `crate still in the tower: ${at(crate)}`,
    );
  }
  assert(Math.max(...tower.map((e) => at(e)[1])) > 8.5, "and still tall");
  const pyramid = world.entities.filter((e) =>
    e.components.body && Math.abs(at(e)[2] + 7) < 0.5
  );
  assertEquals(pyramid.length, 15);
  assert(
    pyramid.every((e) =>
      e.components.body &&
      (e.components.body as { sleeping: boolean }).sleeping
    ),
    "the pyramid has settled",
  );
});

Deno.test("balls fired from the player knock the tower over", async () => {
  const play = await start("physics", (file) => {
    // Aim at the tower: it stands at x = -6, z = -3; turn the player to -X.
    const player = file.entities.find((e) => e.name === "Player")!;
    const t = player.components.transform as {
      position: number[];
      rotation: number[];
    };
    t.position = [0, 0, -3];
    t.rotation = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)];
  });
  play.step(30);
  for (let shot = 0; shot < 6; shot++) {
    play.step(1, (input) => {
      input.actions.fire = { down: true, pressed: true, released: false };
    });
    play.step(20);
  }
  play.step(120);
  const world = play.world();
  const top = world.entities
    .filter((e) => e.components.body && at(e)[0] < -3.5 && at(e)[0] > -9)
    .map((e) => at(e)[1]);
  assert(
    Math.max(...top) < 6,
    `the tower is no longer 10 high: ${Math.max(...top)}`,
  );
});
