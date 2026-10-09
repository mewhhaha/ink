/** Terrain edits through a real `Session`: undo, redo and the collision grid. */
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { Session } from "@ink/core";
import {
  type Catalog,
  defineSchema,
  type SceneFile,
  standard,
} from "@ink/schema";
import { collisionGrid, Heightfield, ScatterSet } from "@ink/geometry";
import { ScatterResource, TerrainResource } from "@ink/render";
import { commitScatter, commitTerrain, rebuildCollisionGrids } from "./edit.ts";
import { gridState, paramsOf } from "./grid.ts";
import {
  type Dab,
  DabPath,
  footprint,
  type Ground,
  paintLayer,
  raise,
} from "./sculpt.ts";
import { StrokeRecorder } from "./stroke.ts";
import { ScatterStroke } from "./scatter_stroke.ts";
import { planAdd, scatterCandidates } from "./scatter_brush.ts";
import { WorldSync } from "./sync.ts";
import { worldRefs } from "./world.ts";

const schema = defineSchema({
  components: {
    transform: standard.transform,
    ...standard.componentsWorld,
  },
  resources: {},
  events: { ...standard.events },
  actions: {},
});
const catalog: Catalog = {
  assets: {
    mesh: ["builtin:cube"],
    texture: [],
    sound: [],
    terrain: ["t.terrain"],
    scatter: ["s.scatter"],
  },
};
const scene: SceneFile = {
  ink: 1,
  entities: [
    {
      id: 1,
      name: "Ground",
      components: {
        transform: {},
        terrain: {
          heightmap: "t.terrain",
          size: 128,
          height_scale: 2,
          collision_cells: 16,
          grid: new Array(17 * 17).fill(0),
          detail_amplitude: 0,
        },
      },
    },
    {
      id: 2,
      name: "Trees",
      components: {
        transform: {},
        scatter: { shape: "builtin:cube", placements: "s.scatter" },
      },
    },
  ],
};

function setup() {
  const session = new Session({ schema, catalog, scene, sceneName: "main" });
  const field = Heightfield.create(128, { splatCells: 64, layers: 4 });
  const terrain = TerrainResource.ready("t.terrain", field);
  const scatter = ScatterResource.ready("s.scatter", new ScatterSet());
  const assets = {
    terrain: () => terrain,
    scatter: () => scatter,
  };
  return { session, field, terrain, scatter, assets };
}

const component = (session: Session, id: number, name: string) =>
  session.entity(id)!.components[name];

/** One sculpt drag, the way the raise tool does it. */
function raiseStroke(terrain: TerrainResource, field: Heightfield) {
  const ground: Ground = { field, size: 128 };
  const recorder = new StrokeRecorder(terrain);
  const path = new DabPath(4);
  const apply = ([x, z]: [number, number]) => {
    const dab: Dab = {
      x,
      z,
      radius: 14,
      falloff: { shape: "smooth", hardness: 0.2 },
    };
    const fp = footprint(ground, dab);
    recorder.prepare(fp);
    raise(ground, dab, 1.5);
    terrain.markDirty(fp.rect!);
  };
  path.start(-30, 0).forEach(apply);
  path.move(30, 10).forEach(apply);
  return recorder.finish()!;
}

Deno.test("a stroke is one undo step that carries the data and the grid", () => {
  const { session, field, terrain, assets } = setup();
  const sync = new WorldSync(session, assets);
  const stop = sync.start();
  const flat = field.heights.slice();

  const before = terrain.revision;
  const done = raiseStroke(terrain, field);
  const painted = field.heights.slice();
  assert(done.revision > before);
  assert(commitTerrain(session, 1, terrain, done, before, "Raise ground"));

  const t = component(session, 1, "terrain");
  assertEquals(t.revision, done.revision);
  // The grid follows the heightmap, `height_scale` included.
  const expected = collisionGrid(field, paramsOf(t), 16);
  assertEquals(t.grid as number[], Array.from(expected));
  assert((t.grid as number[]).some((v) => v > 1));
  assertEquals(gridState(t, field), "ok");
  assertEquals(session.history().undo.at(-1), "Raise ground");

  // One undo takes the whole drag back: scene and data together.
  session.undo();
  assertEquals(component(session, 1, "terrain").revision, 0);
  assertEquals(
    (component(session, 1, "terrain").grid as number[]).every((v) => v === 0),
    true,
  );
  assertEquals(terrain.revision, 0);
  assertEquals(field.heights, flat);

  session.redo();
  assertEquals(component(session, 1, "terrain").revision, done.revision);
  assertEquals(terrain.revision, done.revision);
  assertEquals(field.heights, painted);
  stop();
});

Deno.test("two strokes undo one at a time", () => {
  const { session, field, terrain, assets } = setup();
  const stop = new WorldSync(session, assets).start();
  const first = raiseStroke(terrain, field);
  commitTerrain(session, 1, terrain, first, 0, "one");
  const afterOne = field.heights.slice();
  const second = raiseStroke(terrain, field);
  commitTerrain(session, 1, terrain, second, first.revision, "two");
  assert(second.revision > first.revision);

  session.undo();
  assertEquals(terrain.revision, first.revision);
  assertEquals(field.heights, afterOne);
  session.undo();
  assertEquals(terrain.revision, 0);
  assertEquals(field.heights, Heightfield.create(128).heights);
  stop();
});

Deno.test("a refused edit puts the data back", () => {
  const { session, field, terrain } = setup();
  const done = raiseStroke(terrain, field);
  // There is no entity 99: the recipe fails and nothing is recorded.
  assertEquals(commitTerrain(session, 99, terrain, done, 0, "Raise"), false);
  assertEquals(terrain.revision, 0);
  assertEquals(field.heights, Heightfield.create(128).heights);
  assertEquals(component(session, 1, "terrain").revision, 0);
});

Deno.test("painting records a revision without touching the grid", () => {
  const { session, field, terrain, assets } = setup();
  const stop = new WorldSync(session, assets).start();
  const ground: Ground = { field, size: 128 };
  const recorder = new StrokeRecorder(terrain);
  const dab: Dab = {
    x: 0,
    z: 0,
    radius: 20,
    falloff: { shape: "constant", hardness: 0 },
  };
  const fp = footprint(ground, dab, true);
  recorder.prepare(fp);
  paintLayer(ground, dab, 2, 1);
  const done = recorder.finish()!;
  assertEquals(done.area, null);
  commitTerrain(session, 1, terrain, done, 0, "Paint");
  const grid = component(session, 1, "terrain").grid as number[];
  assert(grid.every((v) => v === 0));
  const n = field.splatCells;
  assertEquals(field.splat[(32 * n + 32) * 4 + 2], 255);
  session.undo();
  assertEquals(field.splat[(32 * n + 32) * 4 + 2], 0);
  assertEquals(field.splat[(32 * n + 32) * 4], 255);
  session.redo();
  assertEquals(field.splat[(32 * n + 32) * 4 + 2], 255);
  stop();
});

Deno.test("scatter strokes follow undo too", () => {
  const { session, scatter, assets } = setup();
  const stop = new WorldSync(session, assets).start();
  const brush = {
    seed: 1,
    density: 0.05,
    minSpacing: 2,
    scale: [1, 1] as [number, number],
    tint: [0, 1] as [number, number],
  };
  const flat = { shape: "constant", hardness: 0 } as const;
  const stroke = new ScatterStroke(scatter);
  stroke.add(
    planAdd(scatter.set!, scatterCandidates(brush, 0, 0, 30, flat), 2),
  );
  const added = scatter.set!.count;
  assert(added > 10);
  const revision = stroke.finish()!;
  assert(commitScatter(session, 2, scatter, revision, 0, "Paint instances"));
  assertEquals(component(session, 2, "scatter").revision, revision);
  session.undo();
  assertEquals(scatter.set!.count, 0);
  session.redo();
  assertEquals(scatter.set!.count, added);
  stop();
});

Deno.test("a grid that is missing or stale is reported and rebuilt on request", () => {
  const { session, field, terrain, assets } = setup();
  // The scene came from a script that left the grid empty.
  session.edit("Break the grid", (world) => {
    world.entities[0].components.terrain.grid = [];
  });
  field.heights.fill(3);
  const t = () => component(session, 1, "terrain");
  assertEquals(gridState(t(), field), "missing");
  // Nothing rebuilds it behind the user's back.
  const stop = new WorldSync(session, assets).start();
  assertEquals((t().grid as number[]).length, 0);
  assertEquals(rebuildCollisionGrids(session, assets, [2]), 0);
  assertEquals(rebuildCollisionGrids(session, assets), 1);
  assertEquals(gridState(t(), field), "ok");
  assertAlmostEquals((t().grid as number[])[8 * 17 + 8], 6, 1e-5);
  // A changed height scale makes it stale; rebuilding is one undo step.
  session.edit("Scale", (world) => {
    world.entities[0].components.terrain.height_scale = 4;
  });
  assertEquals(gridState(t(), field), "stale");
  assertEquals(rebuildCollisionGrids(session, assets), 1);
  assertEquals(gridState(t(), field), "ok");
  session.undo();
  assertEquals(gridState(t(), field), "stale");
  stop();
  assertEquals(terrain.revision, 0);
});

Deno.test("a revision the data has no history for is left alone", () => {
  const { session, terrain, assets } = setup();
  const stop = new WorldSync(session, assets).start();
  // A scene saved elsewhere says revision 7; this session never saw it.
  session.edit("Set revision", (world) => {
    world.entities[0].components.terrain.revision = 7;
  });
  assertEquals(terrain.revision, 0);
  assertEquals(
    worldRefs(session.world, session.catalog).terrains[0].revision,
    7,
  );
  // Looking again does not retry forever or change anything.
  session.edit("Touch", (world) => {
    world.entities[0].components.terrain.size = 256;
  });
  assertEquals(terrain.revision, 0);
  stop();
});
