/** Loads the terrain gate scene through the schema and steps its game. */
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createGameCompiler } from "@ink/blot/compiler";
import { loadGame } from "@ink/blot";
import {
  decodeWorld,
  encodeWorld,
  idleInput,
  type SceneFile,
  sceneToWorld,
} from "@ink/schema";
import { loadSchema } from "@ink/dev/node";
import { catalogFromPaths } from "@ink/dev/catalog";
import { assetPaths, COLLISION_CELLS } from "./scripts/scene.ts";

const root = fromFileUrl(new URL(".", import.meta.url));
const schema = await loadSchema(`${root}schema.ts`, Date.now());
// The catalog is built from the paths the scene names, so the test does not
// depend on the generated binaries being present.
const catalog = catalogFromPaths(assetPaths());
const scene: SceneFile = JSON.parse(
  await Deno.readTextFile(`${root}scenes/main.scene.json`),
);

Deno.test("the scene loads through the schema with every asset resolved", () => {
  const loaded = sceneToWorld(schema, scene, catalog);
  assertEquals(loaded.problems, []);
  const byName = new Map(loaded.world.entities.map((e) => [
    loaded.names.get(e.id),
    e,
  ]));
  for (
    const name of [
      "Terrain",
      "Pines",
      "Oaks",
      "Rocks",
      "Grass",
      "Sun",
      "Environment",
      "Camera",
      "Player",
    ]
  ) assert(byName.has(name), `${name} is in the scene`);

  const terrain = byName.get("Terrain")!.components.terrain as Record<
    string,
    unknown
  >;
  assertEquals(terrain.size, 2048);
  assertEquals((terrain.layers as unknown[]).length, 4);
  assertEquals(
    (terrain.grid as number[]).length,
    (COLLISION_CELLS + 1) ** 2,
  );
  assertEquals(terrain.collision_cells, COLLISION_CELLS);
  assert(terrain.heightmap !== 0, "the heightmap resolves to an asset id");

  for (const name of ["Pines", "Oaks", "Rocks", "Grass"]) {
    const scatter = byName.get(name)!.components.scatter as Record<
      string,
      unknown
    >;
    assert(scatter.shape !== 0 && scatter.placements !== 0, `${name} assets`);
  }
  // Four scatter layers and a handful of other entities, not 100,000.
  assert(loaded.world.entities.length < 20);
});

Deno.test("the walker stands on the ground and walks over it", async () => {
  const compiler = await createGameCompiler({
    entry: `${root}game/main.blot`,
    schema,
    catalog,
  });
  const build = await compiler.build();
  assert(build.ok, "game compiles");
  await compiler.dispose();
  const game = await loadGame(build.bytes, schema);

  let state = encodeWorld(schema, sceneToWorld(schema, scene, catalog).world);
  const first = state[1];
  const walker = (s: Float32Array) =>
    decodeWorld(schema, s).entities.find((e) => e.components.walker)!
      .components;
  const start = walker(state).transform.position as number[];
  for (let tick = first; tick < first + 30; tick++) {
    state = game.step(state, idleInput(schema, tick, 1 / 60)).state;
  }
  const settled = walker(state).transform.position as number[];
  // Idle: the walker settles onto the ground and stays within a hand's breadth.
  assert(Math.abs(settled[0] - start[0]) < 1e-4, "x unchanged");
  assert(
    Math.abs(settled[1] - start[1]) < 0.6,
    `y ${start[1]} -> ${settled[1]}`,
  );
  assertEquals(walker(state).walker.grounded, true);

  // Hold "up" for two seconds: it walks north (-z) and stays on the ground.
  for (let tick = first + 30; tick < first + 150; tick++) {
    const input = idleInput(schema, tick, 1 / 60);
    (input.actions as Record<string, unknown>).move = [0, 1];
    state = game.step(state, input).state;
  }
  const walked = walker(state);
  const at = walked.transform.position as number[];
  assert(at[2] < settled[2] - 8, `walked ${settled[2] - at[2]} m`);
  assertEquals(walked.walker.grounded, true);
});
