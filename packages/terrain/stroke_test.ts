import { assert, assertEquals } from "@std/assert";
import { Heightfield } from "@ink/geometry";
import { TerrainResource } from "@ink/render";
import {
  type Dab,
  DabPath,
  type Falloff,
  flatten,
  footprint,
  type Ground,
  noiseRelief,
  paintLayer,
  raise,
  smooth,
} from "./sculpt.ts";
import { STROKE_TILE, StrokeRecorder } from "./stroke.ts";

const falloff: Falloff = { shape: "smooth", hardness: 0.2 };

function setup(cells = 512, size = 512) {
  const field = Heightfield.create(cells, {
    splatCells: cells / 2,
    layers: 6,
  });
  const resource = TerrainResource.ready("test.terrain", field);
  const ground: Ground = { field, size };
  return { field, resource, ground };
}

type Operation = (ground: Ground, dab: Dab) => void;

/** Drag along a polyline the way the tools do: prepare, change, mark. */
function drag(
  resource: TerrainResource,
  ground: Ground,
  points: [number, number][],
  radius: number,
  operation: Operation,
  paints = false,
) {
  const recorder = new StrokeRecorder(resource);
  const path = new DabPath(radius * 0.25);
  const dab = ([x, z]: [number, number]): Dab => ({ x, z, radius, falloff });
  const apply = (at: [number, number]) => {
    const d = dab(at);
    const fp = footprint(ground, d, paints);
    recorder.prepare(fp);
    operation(ground, d);
    resource.markDirty(
      fp.rect ?? { x0: 0, z0: 0, x1: 0, z1: 0 },
      fp.splatRect ?? undefined,
    );
  };
  path.start(...points[0]).forEach(apply);
  for (const p of points.slice(1)) path.move(...p).forEach(apply);
  return recorder;
}

const snapshot = (field: Heightfield) => ({
  heights: field.heights.slice(),
  splat: field.splat.slice(),
});

function assertField(
  field: Heightfield,
  expected: ReturnType<typeof snapshot>,
) {
  assertEquals(field.heights, expected.heights);
  assertEquals(field.splat, expected.splat);
}

Deno.test("a stroke commits tiles and seek undoes and redoes all of it", () => {
  const { field, resource, ground } = setup();
  const start = snapshot(field);
  const recorder = drag(
    resource,
    ground,
    [[-200, -150], [150, -150], [200, 100]],
    24,
    (g, d) => raise(g, d, 0.8),
  );
  const done = recorder.finish();
  assert(done);
  const finished = snapshot(field);
  assert(done.revision >= 2, "a long drag spans several tiles");
  assertEquals(resource.revision, done.revision);
  assert(done.area && done.area.x1 - done.area.x0 > 300);
  assert(!sameHeights(start, finished));

  assert(resource.seek(0));
  assertField(field, start);
  assertEquals(field.revision, 0);
  assert(resource.seek(done.revision));
  assertField(field, finished);
  assertEquals(field.revision, done.revision);
  // Partway back is a state in between, and forward again is exact.
  assert(resource.seek(1));
  assert(resource.seek(done.revision));
  assertField(field, finished);
});

const sameHeights = (
  a: ReturnType<typeof snapshot>,
  b: ReturnType<typeof snapshot>,
) => a.heights.every((v, i) => v === b.heights[i]);

Deno.test("sculpting, smoothing, painting and noise all undo to the byte", () => {
  const { field, resource, ground } = setup();
  const states = [snapshot(field)];
  const revisions = [0];
  const run = (
    points: [number, number][],
    radius: number,
    op: Operation,
    paints = false,
  ) => {
    const done = drag(resource, ground, points, radius, op, paints).finish();
    assert(done, "the stroke should change something");
    states.push(snapshot(field));
    revisions.push(done.revision);
  };
  run([[-100, 0], [100, 40]], 30, (g, d) => raise(g, d, 1.5));
  run([[-80, 10], [90, 30]], 20, (g, d) => smooth(g, d, 0.6, 3));
  run([[-20, -60], [60, 60]], 25, (g, d) => paintLayer(g, d, 5, 0.7), true);
  run([[0, 0], [30, -20]], 40, (g, d) => paintLayer(g, d, 4, 0.5), true);
  run([[-150, 100], [50, 120]], 16, (g, d) => flatten(g, d, 2, 0.5));
  run(
    [[-60, -90], [60, -80]],
    22,
    (g, d) =>
      noiseRelief(g, d, { seed: 9, scale: 18, octaves: 3, metres: 0.7 }),
  );
  run(
    [[20, 20], [-30, 30]],
    28,
    (g, d) => paintLayer(g, d, 5, 0.9, true),
    true,
  );

  // Walk back through every stroke, then forward, in both directions.
  for (let i = states.length - 1; i >= 0; i--) {
    assert(resource.seek(revisions[i]));
    assertField(field, states[i]);
  }
  for (let i = 0; i < states.length; i++) {
    assert(resource.seek(revisions[i]));
    assertField(field, states[i]);
  }
  for (const i of [4, 1, 6, 2, 0, 5, 3, 6]) {
    assert(resource.seek(revisions[i]));
    assertField(field, states[i]);
  }
});

Deno.test("splat weights stay normalised through undo, redo and a new stroke", () => {
  const { field, resource, ground } = setup(256, 256);
  const stroke = (op: Operation) =>
    drag(resource, ground, [[-90, -90], [90, 90]], 40, op, true).finish()!;
  const a = stroke((g, d) => paintLayer(g, d, 3, 0.6));
  const b = stroke((g, d) => paintLayer(g, d, 1, 0.6));
  resource.seek(a.revision);
  resource.seek(0);
  resource.seek(b.revision);
  const n = field.splatCells;
  for (let i = 0; i < n * n; i++) {
    let sum = 0;
    for (let l = 0; l < field.layers; l++) {
      sum += field.splat[(l >> 2) * n * n * 4 + i * 4 + (l & 3)];
    }
    assertEquals(sum, 255, `texel ${i}`);
  }
  // A new stroke after going back forks the history.
  resource.seek(a.revision);
  const c = stroke((g, d) => paintLayer(g, d, 2, 0.4));
  assert(c.revision > a.revision);
  // What was undone is gone, not reachable by going forward.
  resource.seek(a.revision);
  assert(resource.seek(c.revision));
  assertEquals(resource.seek(c.revision + 1), false);
});

Deno.test("reverting a stroke restores the field and records nothing", () => {
  const { field, resource, ground } = setup();
  const start = snapshot(field);
  const recorder = drag(
    resource,
    ground,
    [[-120, 0], [120, 0]],
    30,
    (g, d) => raise(g, d, 2),
  );
  assert(recorder.started);
  assert(!sameHeights(start, snapshot(field)));
  recorder.revert();
  assertField(field, start);
  assertEquals(resource.revision, 0);
  assertEquals(recorder.finish(), null);
  const paint = drag(
    resource,
    ground,
    [[0, 0], [100, 100]],
    30,
    (g, d) => paintLayer(g, d, 1, 1),
    true,
  );
  paint.revert();
  assertField(field, start);
});

Deno.test("a stroke that changes nothing leaves no revision", () => {
  const { field, resource, ground } = setup();
  const off = drag(
    resource,
    ground,
    [[900, 900], [950, 950]],
    20,
    (g, d) => raise(g, d, 1),
  );
  assertEquals(off.finish(), null);
  // Raising by zero is not a change either.
  const zero = drag(
    resource,
    ground,
    [[0, 0], [40, 0]],
    20,
    (g, d) => raise(g, d, 0),
  );
  assertEquals(zero.finish(), null);
  assertEquals(resource.revision, 0);
  assertEquals(field.revision, 0);
});

Deno.test("history holds only the tiles a stroke touched", () => {
  const { resource, ground } = setup(2048, 2048);
  const changes: number[] = [];
  resource.onChange((c) => {
    changes.push(c.patch.heights.length);
    assert(c.patch.rect.x1 - c.patch.rect.x0 <= STROKE_TILE);
  });
  const done = drag(
    resource,
    ground,
    [[0, 0], [150, 0]],
    16,
    (g, d) => raise(g, d, 1),
  )
    .finish()!;
  // 150 m x 32 m is a handful of 64 x 64 tiles, not the 4.2 million samples.
  assert(done.revision <= 8, `${done.revision} tiles`);
  assertEquals(changes.length, done.revision);
  assert(changes.every((n) => n <= STROKE_TILE * STROKE_TILE));
});

Deno.test("a stroke whose data was reloaded underneath records nothing", () => {
  const { field, resource, ground } = setup();
  const recorder = drag(
    resource,
    ground,
    [[-80, 0], [80, 0]],
    20,
    (g, d) => raise(g, d, 2),
  );
  // The file changed on disk and the resource took the new copy.
  resource.setField(Heightfield.create(512, { splatCells: 256, layers: 6 }));
  assertEquals(recorder.finish(), null);
  assertEquals(resource.revision, 0);
  assert(resource.field !== field);
});
