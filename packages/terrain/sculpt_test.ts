import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { Heightfield, terrainNoise } from "@ink/geometry";
import {
  type Dab,
  DabPath,
  type Falloff,
  falloffWeight,
  flatten,
  footprint,
  type Ground,
  noiseRelief,
  paintLayer,
  raise,
  smooth,
} from "./sculpt.ts";

const smoothFalloff: Falloff = { shape: "smooth", hardness: 0 };
const constant: Falloff = { shape: "constant", hardness: 0 };

/** 128 m terrain with 1 m cells; terrain-local (0, 0) is sample (64, 64). */
const ground = (layers = 4): Ground => ({
  field: Heightfield.create(128, { splatCells: 64, layers }),
  size: 128,
});

const dabAt = (x: number, z: number, radius = 10): Dab => ({
  x,
  z,
  radius,
  falloff: smoothFalloff,
});

Deno.test("falloff curves run from full strength to nothing", () => {
  for (const shape of ["smooth", "linear", "sphere", "tip"] as const) {
    const f: Falloff = { shape, hardness: 0 };
    assertEquals(falloffWeight(f, 0), 1, shape);
    assertEquals(falloffWeight(f, 1), 0, shape);
    let last = 1;
    for (let q = 0; q <= 1; q += 0.05) {
      const w = falloffWeight(f, q);
      assert(w <= last + 1e-12, `${shape} is not monotonic at ${q}`);
      last = w;
    }
  }
  const hard: Falloff = { shape: "smooth", hardness: 0.5 };
  assertEquals(falloffWeight(hard, 0.5), 1);
  assertAlmostEquals(falloffWeight(hard, 0.75), 0.5, 1e-9);
  assertEquals(falloffWeight({ shape: "constant", hardness: 0 }, 0.99), 1);
});

Deno.test("raise changes only the dab's circle and reports its rectangle", () => {
  const g = ground();
  const before = g.field.heights.slice();
  const touched = raise(g, dabAt(0, 0), 2);
  assertEquals(touched.rect, { x0: 54, z0: 54, x1: 75, z1: 75 });
  const s = g.field.stride;
  assertAlmostEquals(g.field.heights[64 * s + 64], 2, 1e-5);
  let changed = 0;
  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) {
      const i = z * s + x;
      if (g.field.heights[i] === before[i]) continue;
      changed++;
      assert(Math.hypot(x - 64, z - 64) < 10, "changed outside the radius");
      assert(x >= 54 && x < 75 && z >= 54 && z < 75, "outside the rect");
    }
  }
  assert(changed > 250 && changed < 330, `${changed} samples changed`);
  // Lowering is the same operation with the opposite sign.
  raise(g, dabAt(0, 0), -2);
  for (let i = 0; i < before.length; i++) {
    assertAlmostEquals(g.field.heights[i], before[i], 1e-5);
  }
});

Deno.test("dabs clip to the field and vanish beyond it", () => {
  const g = ground();
  const corner = raise(g, dabAt(-64, -64), 1);
  assertEquals(corner.rect, { x0: 0, z0: 0, x1: 11, z1: 11 });
  assertEquals(raise(g, dabAt(500, 0), 1).rect, null);
  assertEquals(footprint(g, dabAt(500, 0)).rect, null);
  assertEquals(footprint(g, dabAt(0, 0)).rect, {
    x0: 54,
    z0: 54,
    x1: 75,
    z1: 75,
  });
});

Deno.test("smooth relaxes a spike without touching anything outside", () => {
  const g = ground();
  const s = g.field.stride;
  g.field.heights[64 * s + 64] = 10;
  const before = g.field.heights.slice();
  smooth(g, dabAt(0, 0), 1, 2);
  assert(g.field.heights[64 * s + 64] < 10, "the spike should drop");
  assert(g.field.heights[64 * s + 65] > 0, "its neighbours should rise");
  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) {
      if (Math.hypot(x - 64, z - 64) >= 10) {
        assertEquals(g.field.heights[z * s + x], before[z * s + x]);
      }
    }
  }
  // A kernel-1 average of a lone spike is a ninth of it, spread over the nine
  // samples around it.
  const h = ground();
  h.field.heights[64 * s + 64] = 9;
  smooth(h, { ...dabAt(0, 0), falloff: constant }, 1, 1);
  assertAlmostEquals(h.field.heights[64 * s + 64], 1, 1e-4);
  assertAlmostEquals(h.field.heights[64 * s + 65], 1, 1e-4);
  assertAlmostEquals(h.field.heights[65 * s + 65], 1, 1e-4);
  assertAlmostEquals(h.field.heights[64 * s + 66], 0, 1e-4);
});

Deno.test("smooth keeps a plane and works at the border", () => {
  const g = ground();
  const s = g.field.stride;
  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) g.field.heights[z * s + x] = x * 0.5;
  }
  const before = g.field.heights.slice();
  smooth(g, dabAt(-64, 0, 12), 1, 3);
  // Away from the border a box average of a plane is the plane itself.
  for (let z = 50; z < 78; z++) {
    for (let x = 4; x < 8; x++) {
      assertAlmostEquals(g.field.heights[z * s + x], before[z * s + x], 1e-4);
    }
  }
});

Deno.test("flatten pulls heights toward a level or a plane", () => {
  const g = ground();
  const s = g.field.stride;
  g.field.heights.fill(5);
  flatten(
    g,
    { ...dabAt(0, 0), falloff: { shape: "constant", hardness: 0 } },
    2,
    1,
  );
  assertAlmostEquals(g.field.heights[64 * s + 64], 2, 1e-5);
  assertEquals(g.field.heights[0], 5);
  const tilted = ground();
  flatten(
    tilted,
    { ...dabAt(0, 0, 20), falloff: { shape: "constant", hardness: 0 } },
    { height: 1, x: 0, z: 0, slopeX: 0.5, slopeZ: 0 },
    1,
  );
  assertAlmostEquals(tilted.field.heights[64 * s + 64], 1, 1e-5);
  assertAlmostEquals(tilted.field.heights[64 * s + 74], 6, 1e-5);
  assertAlmostEquals(tilted.field.heights[64 * s + 54], -4, 1e-5);
});

Deno.test("noise adds the shared terrain noise, seam free between dabs", () => {
  const brush = { seed: 7, scale: 12, octaves: 3, metres: 1.5 };
  const wide: Falloff = { shape: "constant", hardness: 0 };
  const g = ground();
  noiseRelief(g, { x: 0, z: 0, radius: 10, falloff: wide }, brush);
  const s = g.field.stride;
  // Sample (64, 64) is terrain-local (0, 0); sample (70, 64) is (6, 0).
  assertAlmostEquals(
    g.field.heights[64 * s + 70],
    1.5 * terrainNoise(7, 3, 6 / 12, 0),
    1e-5,
  );
  // The value at a sample does not depend on which dab produced it.
  const a = ground(), b = ground();
  noiseRelief(a, { x: 0, z: 0, radius: 20, falloff: wide }, brush);
  noiseRelief(b, { x: 8, z: 0, radius: 20, falloff: wide }, brush);
  assertEquals(a.field.heights[64 * s + 70], b.field.heights[64 * s + 70]);
  let range = 0;
  for (const v of g.field.heights) range = Math.max(range, Math.abs(v));
  assert(range > 0.1 && range < 3, `relief ${range}`);
});

function texel(g: Ground, x: number, z: number): number[] {
  const n = g.field.splatCells, out: number[] = [];
  for (let l = 0; l < g.field.layers; l++) {
    out.push(g.field.splat[(l >> 2) * n * n * 4 + (z * n + x) * 4 + (l & 3)]);
  }
  return out;
}

Deno.test("paint trades weight between layers and keeps the sum at 255", () => {
  const g = ground(6);
  const n = g.field.splatCells;
  // Terrain-local (0, 0) is texel (32, 32) (64 texels over 128 m).
  const dab = { ...dabAt(0, 0, 8), falloff: constant };
  const touched = paintLayer(g, dab, 5, 0.4);
  assertEquals(touched.rect, null);
  assert(touched.splatRect !== null);
  const middle = texel(g, 32, 32);
  assertEquals(middle.reduce((a, b) => a + b, 0), 255);
  assertEquals(middle[5], 102);
  assertEquals(middle[0], 153);
  // Painting more keeps normalising, across both planes.
  paintLayer(g, dab, 4, 1);
  const again = texel(g, 32, 32);
  assertEquals(again.reduce((a, b) => a + b, 0), 255);
  assertEquals(again[4], 255);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      assertEquals(texel(g, x, z).reduce((a, b) => a + b, 0), 255);
    }
  }
  // A texel outside the radius is untouched.
  assertEquals(texel(g, 0, 0), [255, 0, 0, 0, 0, 0]);
  // Erasing gives the share back to the others, in proportion.
  paintLayer(g, dab, 4, 1, true);
  const erased = texel(g, 32, 32);
  assertEquals(erased[4], 0);
  assertEquals(erased.reduce((a, b) => a + b, 0), 255);
});

Deno.test("erasing the only layer, and unknown layers, change nothing", () => {
  const g = ground(1);
  const before = g.field.splat.slice();
  paintLayer(g, dabAt(0, 0, 8), 0, 1, true);
  paintLayer(g, dabAt(0, 0, 8), 3, 1);
  assertEquals(g.field.splat, before);
});

Deno.test("dabs follow the path the same way however it is sampled", () => {
  const dabs = (steps: number) => {
    const path = new DabPath(3);
    const out = [...path.start(0, 0)];
    // The same L-shaped path (50 m along x, 20 m along z), reported at
    // different rates.
    for (let i = 1; i <= steps; i++) out.push(...path.move(i / steps * 50, 0));
    for (let i = 1; i <= steps; i++) out.push(...path.move(50, i / steps * 20));
    return out;
  };
  const coarse = dabs(5), fine = dabs(500), finer = dabs(3333);
  assertEquals(coarse.length, fine.length);
  assertEquals(fine.length, finer.length);
  // 50 m along x, then 20 m along z, 3 m apart: 23 dabs after the first.
  assertEquals(fine.length, 1 + Math.floor(70 / 3));
  for (let i = 0; i < fine.length; i++) {
    assertAlmostEquals(coarse[i][0], fine[i][0], 1e-6);
    assertAlmostEquals(coarse[i][1], fine[i][1], 1e-6);
    assertAlmostEquals(finer[i][0], fine[i][0], 1e-6);
    assertAlmostEquals(finer[i][1], fine[i][1], 1e-6);
  }
});

Deno.test("a dab on a large field costs the same as on a small one", () => {
  // Only the dab's rectangle is read or written: this runs in milliseconds
  // and leaves the rest of 4.2 million samples untouched.
  const field = Heightfield.create(2048, { splatCells: 1024, layers: 4 });
  const g: Ground = { field, size: 2048 };
  const start = performance.now();
  const touched = raise(g, dabAt(500, -300, 64), 1);
  smooth(g, dabAt(500, -300, 64), 0.5, 4);
  const elapsed = performance.now() - start;
  const w = touched.rect!.x1 - touched.rect!.x0;
  assertEquals(w, 129);
  assert(elapsed < 500, `two dabs took ${elapsed} ms`);
});
