import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  collisionGrid,
  Heightfield,
  readPatch,
  ScatterSet,
  terrainDetail,
  terrainHeightAt,
  terrainNormalAt,
  writePatch,
} from "./mod.ts";

Deno.test("terrain files round-trip", () => {
  const field = Heightfield.create(64, { layers: 6 });
  for (let i = 0; i < field.heights.length; i++) field.heights[i] = Math.sin(i);
  field.splat[17] = 99;
  field.revision = 7;
  const copy = Heightfield.parse(field.serialize());
  assertEquals(copy.cells, 64);
  assertEquals(copy.layers, 6);
  assertEquals(copy.revision, 7);
  assertEquals(copy.heights, field.heights);
  assertEquals(copy.splat, field.splat);
});

Deno.test("heights interpolate and patches restore regions", () => {
  const field = Heightfield.create(8);
  field.heights[4 * 9 + 4] = 10;
  const params = {
    size: 8,
    heightScale: 2,
    detail: { seed: 1, amplitude: 0, wavelength: 4, octaves: 1 },
  };
  // Terrain-local (0, 0) is the field centre, sample (4, 4).
  assertAlmostEquals(terrainHeightAt(field, params, 0, 0), 20, 1e-9);
  assertAlmostEquals(terrainHeightAt(field, params, 0.5, 0), 10, 1e-9);
  const n = terrainNormalAt(field, params, 1, 0);
  assert(n[0] > 0 && n[1] > 0);

  const before = readPatch(field, { x0: 2, z0: 2, x1: 7, z1: 7 });
  field.heights.fill(3);
  field.splat.fill(1);
  const after = readPatch(field, { x0: 2, z0: 2, x1: 7, z1: 7 });
  writePatch(field, before);
  assertEquals(field.heights[4 * 9 + 4], 10);
  writePatch(field, after);
  assertEquals(field.heights[4 * 9 + 4], 3);

  const grid = collisionGrid(Heightfield.create(8, { height: 2 }), params, 4);
  assertEquals(grid.length, 25);
  assertEquals(grid[12], 4);
});

Deno.test("detail noise is deterministic and bounded", () => {
  const detail = { seed: 5, amplitude: 1, wavelength: 7, octaves: 4 };
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 4000; i++) {
    const v = terrainDetail(detail, i * 0.37 - 300, i * 0.91 - 700);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
    assertEquals(v, terrainDetail(detail, i * 0.37 - 300, i * 0.91 - 700));
  }
  assert(lo > -1.5 && hi < 1.5 && hi - lo > 0.3, `${lo} ${hi}`);
});

Deno.test("scatter files keep every placement and sort by chunk", () => {
  const set = new ScatterSet(2);
  for (let i = 0; i < 1000; i++) {
    set.add({
      x: (i * 37) % 900 - 450,
      y: 0,
      z: (i * 91) % 700,
      yaw: i,
      scale: 1 + i / 1000,
      tint: 0.5,
    });
  }
  set.revision = 3;
  const copy = ScatterSet.parse(set.serialize());
  assertEquals(copy.count, 1000);
  assertEquals(copy.revision, 3);
  const removed = copy.filter((p) => p.x < 0);
  assertEquals(removed.length + copy.count, 1000);
});
