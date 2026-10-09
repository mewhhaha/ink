import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  Heightfield,
  type Ray,
  terrainHeightAt,
  type TerrainParams,
  type Vec3,
} from "@ink/geometry";
import { TERRAIN_LEAF, TerrainResource } from "@ink/render";
import { raycastTerrain, raycastTerrains } from "./raycast.ts";

const detail = { seed: 3, amplitude: 0.4, wavelength: 7, octaves: 3 };
const params: TerrainParams = { size: 256, heightScale: 1.5, detail };

/** Rolling hills over 256 m with 1 m cells. */
function hills(): Heightfield {
  const field = Heightfield.create(256);
  for (let z = 0; z <= 256; z++) {
    for (let x = 0; x <= 256; x++) {
      field.heights[z * 257 + x] = 12 * Math.sin(x / 23) * Math.cos(z / 31) +
        (x > 150 && z < 100 ? 25 : 0);
    }
  }
  return field;
}

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** The first crossing of the ground by a dense march: the reference. A ray
 * that enters the square below the ground (through a cliff at the border)
 * hits nothing, like one that starts underground. */
function marched(
  ray: Ray,
  field: Heightfield,
  origin: Vec3,
  to = 1200,
): number | null {
  let prev: number | null = null;
  for (let t = 0; t < to; t += 0.05) {
    const x = ray.origin[0] + ray.direction[0] * t - origin[0];
    const z = ray.origin[2] + ray.direction[2] * t - origin[2];
    const y = ray.origin[1] + ray.direction[1] * t - origin[1];
    if (Math.abs(x) > 128 || Math.abs(z) > 128) continue;
    const f = y - terrainHeightAt(field, params, x, z);
    if (prev === null) {
      if (f <= 0) return null;
    } else if (f <= 0) return t;
    prev = f;
  }
  return null;
}

Deno.test("a ray straight down hits the ground height under it", () => {
  const field = Heightfield.create(64, { height: 10 });
  const flat: TerrainParams = {
    size: 64,
    heightScale: 1,
    detail: { ...detail, amplitude: 0 },
  };
  const hit = raycastTerrain(
    { origin: [5, 100, -7], direction: [0, -1, 0] },
    { field, params: flat, origin: [0, 0, 0] },
  );
  assert(hit);
  assertAlmostEquals(hit.distance, 90, 1e-4);
  assertAlmostEquals(hit.point[1], 10, 1e-4);
  assertAlmostEquals(hit.x, 5, 1e-6);
  assertAlmostEquals(hit.z, -7, 1e-6);
  assertAlmostEquals(hit.normal[1], 1, 1e-6);
  // Misses: beside the terrain, pointing away, or starting underground.
  const miss = (origin: Vec3, direction: Vec3) =>
    raycastTerrain({ origin, direction }, {
      field,
      params: flat,
      origin: [0, 0, 0],
    });
  assertEquals(miss([100, 100, 0], [0, -1, 0]), null);
  assertEquals(miss([0, 100, 0], [0, 1, 0]), null);
  assertEquals(miss([0, 4, 0], [0, 0, 1]), null);
  assertEquals(miss([0, 4, 0], [0, -1, 0]), null);
  assertEquals(miss([0, 100, 0], [0, -1, 0]) !== null, true);
});

Deno.test("the terrain's origin moves the ground", () => {
  const field = Heightfield.create(64, { height: 2 });
  const flat: TerrainParams = {
    size: 64,
    heightScale: 2,
    detail: { ...detail, amplitude: 0 },
  };
  const hit = raycastTerrain(
    { origin: [1000, 50, -300], direction: [0, -1, 0] },
    { field, params: flat, origin: [1000, 5, -300] },
  )!;
  assertAlmostEquals(hit.point[1], 5 + 4, 1e-4);
  assertAlmostEquals(hit.x, 0, 1e-6);
});

Deno.test("hits agree with a dense march over rolling hills", () => {
  const field = hills();
  const origin: Vec3 = [30, -4, -12];
  const resource = TerrainResource.ready("hills.terrain", field);
  const surface = {
    field,
    params,
    origin,
    bounds: (x0: number, z0: number, x1: number, z1: number) =>
      resource.boundsOf(x0, z0, x1, z1),
    leaf: TERRAIN_LEAF,
  };
  const bare = { field, params, origin };
  let seed = 1;
  const random = () =>
    (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  let hits = 0;
  for (let n = 0; n < 150; n++) {
    const from: Vec3 = [
      origin[0] + (random() - 0.5) * 360,
      60 + random() * 80,
      origin[2] + (random() - 0.5) * 360,
    ];
    const target: Vec3 = [
      origin[0] + (random() - 0.5) * 250,
      origin[1] + random() * 10,
      origin[2] + (random() - 0.5) * 250,
    ];
    const ray: Ray = {
      origin: from,
      direction: unit([
        target[0] - from[0],
        target[1] - from[1],
        target[2] - from[2],
      ]),
    };
    const expected = marched(ray, field, origin);
    const a = raycastTerrain(ray, surface);
    const b = raycastTerrain(ray, bare);
    if (expected === null) {
      assertEquals(a, null, `ray ${n} should miss`);
      assertEquals(b, null);
      continue;
    }
    hits++;
    assert(a && b, `ray ${n} should hit at ${expected}`);
    assertAlmostEquals(a.distance, expected, 0.06, `ray ${n}`);
    assertAlmostEquals(a.distance, b.distance, 1e-9);
    // The hit lies on the ground and the normal points up.
    assertAlmostEquals(
      a.point[1] - origin[1],
      terrainHeightAt(field, params, a.x, a.z),
      1e-5,
    );
    assert(a.normal[1] > 0);
  }
  assert(hits > 60, `only ${hits} of the rays hit`);
});

Deno.test("grazing rays still find the ridge they cross", () => {
  const field = hills();
  const origin: Vec3 = [0, 0, 0];
  const resource = TerrainResource.ready("hills.terrain", field);
  const surface = {
    field,
    params,
    origin,
    bounds: (x0: number, z0: number, x1: number, z1: number) =>
      resource.boundsOf(x0, z0, x1, z1),
  };
  for (const y of [14, 20, 30]) {
    const ray: Ray = { origin: [-200, y, 10], direction: unit([1, -0.02, 0]) };
    const expected = marched(ray, field, origin, 600);
    const hit = raycastTerrain(ray, surface);
    if (expected === null) assertEquals(hit, null);
    else assertAlmostEquals(hit!.distance, expected, 0.06);
  }
});

Deno.test("the nearest of several terrains wins", () => {
  const low = Heightfield.create(16, { height: 0 });
  const high = Heightfield.create(16, { height: 8 });
  const flat: TerrainParams = {
    size: 32,
    heightScale: 1,
    detail: { ...detail, amplitude: 0 },
  };
  const found = raycastTerrains(
    { origin: [0, 50, 0], direction: [0, -1, 0] },
    [
      { field: low, params: flat, origin: [0, 0, 0] },
      { field: high, params: flat, origin: [0, 0, 0] },
    ],
  );
  assertEquals(found?.index, 1);
  assertAlmostEquals(found!.hit.point[1], 8, 1e-4);
});

Deno.test("a pick across a 2 km terrain stays cheap", () => {
  const field = Heightfield.create(2048, { splatCells: 64 });
  for (let z = 0; z <= 2048; z += 1) {
    for (let x = 0; x <= 2048; x += 1) {
      field.heights[z * 2049 + x] = 60 * Math.sin(x / 150) * Math.cos(z / 170);
    }
  }
  const resource = TerrainResource.ready("big.terrain", field);
  const big: TerrainParams = { size: 2048, heightScale: 1, detail };
  const surface = {
    field,
    params: big,
    origin: [0, 0, 0] as Vec3,
    bounds: (x0: number, z0: number, x1: number, z1: number) =>
      resource.boundsOf(x0, z0, x1, z1),
  };
  const ray: Ray = {
    origin: [-900, 120, -900],
    direction: unit([1, -0.15, 1]),
  };
  raycastTerrain(ray, surface);
  const start = performance.now();
  for (let i = 0; i < 50; i++) raycastTerrain(ray, surface);
  const each = (performance.now() - start) / 50;
  console.log(`  raycast across 2 km: ${each.toFixed(3)} ms`);
  assert(each < 20, `${each} ms`);
});
