import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";

const fixture = await compile(new URL("./heightfield.blot", import.meta.url));
const { guest } = fixture;

interface Field {
  origin?: number[];
  size?: number;
  cells?: number;
  grid?: number[];
  amplitude?: number;
  wavelength?: number;
  octaves?: number;
}

function lanes(field: Field, p: number[], q = p, radius = 0, box = false) {
  let kind = 0;
  if (box) kind = 1;
  return new Float32Array([
    ...(field.origin ?? [0, 0, 0]),
    field.size ?? 8,
    field.cells ?? 1,
    field.amplitude ?? 0,
    field.wavelength ?? 4,
    field.octaves ?? 0,
    7,
    ...p,
    ...q,
    radius,
    kind,
    ...(field.grid ?? [0, 0, 0, 0]),
  ]);
}

function call(entry: string, a: Float32Array): number[] {
  return Array.from(guest.call(entry, a) as Float32Array);
}

Deno.test("heightfield gaps use the finite translated footprint and vertical walls", () => {
  const field = { origin: [10, 3, -5], grid: [1, 1, 1, 1] };
  const above = call("gap", lanes(field, [10, 5, -5]));
  assertAlmostEquals(above[0], 1, 1e-5);
  assertEquals(above.slice(1, 4), [0, 1, 0]);
  assertEquals(above.slice(7), [6, -9, 14, 4, -1]);
  const inside = call("gap", lanes(field, [10, 3.8, -5]));
  assertAlmostEquals(inside[0], -0.2, 1e-5);
  const outside = call("gap", lanes(field, [15, 0, -5]));
  assertAlmostEquals(outside[0], 1, 1e-5);
  assertEquals(outside.slice(1, 4), [1, 0, 0]);
});

Deno.test("heightfield closest points and sphere contacts follow an inclined surface", () => {
  // y = 0.5 x, with a translated origin.
  const field = { origin: [3, 2, -7], grid: [-2, 2, -2, 2] };
  const gap = call("gap", lanes(field, [3, 3, -7]));
  assertAlmostEquals(gap[0], 1 / Math.sqrt(1.25), 2e-4);
  assertAlmostEquals(gap[1], -0.5 / Math.sqrt(1.25), 2e-4);
  assertAlmostEquals(gap[2], 1 / Math.sqrt(1.25), 2e-4);
  const result = call("contacts", lanes(field, [3, 2.55, -7], undefined, 0.5));
  assertEquals(result[0], 1);
  assertAlmostEquals(result[7], 0.55 / Math.sqrt(1.25) - 0.5, 2e-4);
});

Deno.test("a horizontal capsule keeps both supporting ends", () => {
  const a = lanes({}, [-1, 0.49, 0], [1, 0.49, 0], 0.5);
  a[16] = 2;
  const result = call("contacts", a);
  assert(result[0] >= 2);
  for (let i = 0; i < result[0]; i++) {
    const offset = 1 + i * 7;
    assertEquals(result.slice(offset + 3, offset + 6), [0, 1, 0]);
    assertAlmostEquals(result[offset + 6], -0.01, 1e-5);
  }
});

Deno.test("heightfields support a full box face and a rotated corner", () => {
  const flat = call("contacts", lanes({}, [0, 0.49, 0], [1, 0.5, 1], 0, true));
  assertEquals(flat[0], 4);
  for (let i = 0; i < flat[0]; i++) {
    const offset = 1 + i * 7;
    assertEquals(flat.slice(offset + 3, offset + 6), [0, 1, 0]);
    assertAlmostEquals(flat[offset + 6], -0.01, 1e-5);
  }
  const tilted = call(
    "contacts",
    lanes({}, [0, 0.6, 0], [0.5, 0.5, 0.5], Math.PI / 4, true),
  );
  assert(tilted[0] >= 2);
  assert(tilted[7] < -0.1);
});

Deno.test("submerged boxes contact finite terrain walls", () => {
  const result = call(
    "contacts",
    lanes({}, [4.4, -2, 0], [0.5, 0.5, 0.5], 0, true),
  );
  assertEquals(result[0], 4);
  for (let i = 0; i < result[0]; i++) {
    const offset = 1 + i * 7;
    assertEquals(result.slice(offset + 3, offset + 6), [1, 0, 0]);
    assertAlmostEquals(result[offset + 6], -0.1, 1e-5);
  }
});

Deno.test("a point above a valley is clear despite higher terrain borders", () => {
  const field = {
    cells: 2,
    grid: [4, 4, 4, 4, 0, 4, 4, 4, 4],
  };
  const result = call("gap", lanes(field, [0, 0.01, 0]));
  assert(result[0] >= 0);
});

Deno.test("an interior grid peak contacts the middle of a box face", () => {
  const field = { cells: 2, size: 4, grid: [0, 0, 0, 0, 1, 0, 0, 0, 0] };
  const result = call(
    "contacts",
    lanes(field, [0, 1.4, 0], [1, 0.5, 1], 0, true),
  );
  assert(result[0] > 0);
  assert(result[7] < -0.09);
});

Deno.test.afterAll(() => fixture.dispose());

Deno.test("terrain scene queries preserve masks, finite bounds and capsule support", () => {
  const field = { origin: [10, 3, -5], grid: [-2, 2, -2, 2] };
  const a = lanes(field, [10, 8, -5], [0, -10, 0], -1);
  a[16] = 4;
  const ray = call("query", a);
  assertEquals(ray[0], 1);
  assertAlmostEquals(ray[1], 0.5, 2e-4);
  assertAlmostEquals(ray[3], 3, 2e-3);
  assertAlmostEquals(ray[5], -0.5 / Math.sqrt(1.25), 2e-3);
  a[16] = 1;
  assertEquals(call("query", a), [0]);
  a[16] = 4;
  a[9] = 15;
  assertEquals(call("query", a), [0]);
  a[9] = 10;
  a[15] = 0.5;
  const sweep = call("query", a);
  assertEquals(sweep[0], 1);
  assertAlmostEquals(sweep[1], (5 - 0.5 * Math.sqrt(1.25)) / 10, 2e-3);
  assertEquals(call("solid", lanes(field, [10, 2, -5], undefined, 0.1)), [
    1,
    1,
  ]);
  assertEquals(call("solid", lanes(field, [15, 0, -5], undefined, 0.1)), [
    0,
    0,
  ]);
});

Deno.test("a ray hits the same bilinear and procedural surface as terrain.height", () => {
  const field = {
    cells: 2,
    size: 8,
    grid: [0, 2, -1, 1, -2, 3, 2, 0, 1],
    amplitude: 0.35,
    wavelength: 4,
    octaves: 2,
  };
  const a = lanes(field, [0.6, 4, -0.8], [0, -8, 0], -1);
  a[16] = 4;
  const ray = call("query", a);
  assertEquals(ray[0], 1);
  const height = guest.call(
    "height",
    lanes(field, [ray[2], ray[3], ray[4]]),
  ) as number;
  assertAlmostEquals(ray[3], height, 0.002);
});

Deno.test("horizontal casts hit a later uphill feature", () => {
  const field = { cells: 2, grid: [0, 3, 0, 0, 3, 0, 0, 3, 0] };
  const a = lanes(field, [-3, 1.5, 0], [6, 0, 0], -1);
  a[16] = 4;
  const ray = call("query", a);
  assertEquals(ray[0], 1);
  assertAlmostEquals(ray[2], -2, 0.003);
  assertAlmostEquals(ray[3], 1.5, 0.003);
});

Deno.test("falling spheres and rotated boxes settle on finite terrain", () => {
  const field = { origin: [10, 3, -5], grid: [1, 1, 1, 1] };
  const sphere = call("fall", lanes(field, [10, 6, -5], undefined, 0.5));
  assertAlmostEquals(sphere[1], 4.5, 0.03);
  assert(Math.abs(sphere[3]) < 0.1);
  const box = call("fall", lanes(field, [10, 6, -5], [1, 1, 1], 0, true));
  assertAlmostEquals(box[1], 4.5, 0.04);
  assert(Math.abs(box[3]) < 0.1);
  assert(box[4] < 0.2);
});

Deno.test("characters keep ground contact uphill and downhill", () => {
  const field = { size: 16, grid: [-2.4, 2.4, -2.4, 2.4] };
  for (const speed of [-2, 2]) {
    const result = call("walk", lanes(field, [0, 0.05, 0], undefined, speed));
    assert(Math.abs(result[0]) > 2.5);
    assertEquals(result[3], 1);
    assertEquals(result[4], 0);
    // Feet are slightly lifted by the round capsule touching the incline.
    assertAlmostEquals(result[1], result[0] * 0.3 + 0.018, 0.025);
    assertAlmostEquals(result[5], -0.3 / Math.sqrt(1.09), 0.003);
  }
});
