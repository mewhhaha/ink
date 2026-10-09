import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { createCompiler } from "@mewhhaha/blot";
import { instantiateGuest } from "@mewhhaha/blot/guest";
import {
  bool,
  decodeWorld,
  defineSchema,
  encodeWorld,
  f32,
  idleInput,
  sceneToWorld,
  standard,
  vec3,
} from "@ink/schema";
import {
  collisionGrid,
  Heightfield,
  noiseHash3,
  perlin3,
  type TerrainDetail,
  terrainHeightAt,
  terrainNoise,
  terrainNormalAt,
  type TerrainParams,
} from "@ink/geometry";
import { createGameCompiler, formatDiagnostic } from "./compiler.ts";
import { libraryUrl, loadGame } from "./mod.ts";

// The Blot side. Every probe takes the same header, then `count` query rows of
// `width` lanes, then the terrain's grid.
//   0..3 origin, 3 size, 4 cells, 5 amplitude, 6 wavelength, 7 octaves,
//   8 seed, 9 count, 10 width, 11 and 12 extra arguments, 16.. rows
const source = `import * as array from "std/array"
import { Vec2, Vec3 } from "std/vector"
import * as noise from "ink/noise"
import * as terrain from "ink/terrain"
import { Terrain } from "ink/terrain"

const origin_of = fn (lanes: Array F32) => #Vec3 { x: lanes[0], y: lanes[1], z: lanes[2] }

const grid_of = fn (lanes: Array F32) => do:
  let start = 16 + F32.to_u32 lanes[9] * F32.to_u32 lanes[10]
  return array.slice start (lanes.length - start) lanes

const build = fn (lanes: Array F32) =>
  terrain.make (origin_of lanes) lanes[3] (F32.to_u32 lanes[4]) (grid_of lanes) lanes[5] lanes[6] (F32.to_u32 lanes[7]) (F32.to_u32 lanes[8])

const height_row = fn (t: Terrain) => fn (lanes: Array F32) => fn (i: U32) => do:
  let x = lanes[16 + i * 3]
  let z = lanes[17 + i * 3]
  let h = terrain.height t x z
  let inside = if terrain.inside t x z then 1.0 else 0.0
  let g = terrain.ground t (#Vec3 { x, y: lanes[18 + i * 3], z })
  let above = terrain.above t (#Vec3 { x, y: lanes[18 + i * 3], z })
  return #[h, inside, g.y, above]

entry const heights = fn (lanes: Array F32) -> Array F32 => do:
  let t = build lanes
  return array.flatten (array.generate (F32.to_u32 lanes[9]) (height_row t lanes))

const normal_row = fn (t: Terrain) => fn (lanes: Array F32) => fn (i: U32) => do:
  let x = lanes[16 + i * 2]
  let z = lanes[17 + i * 2]
  let n = terrain.normal_by t lanes[11] x z
  let d = terrain.normal t x z
  let g = terrain.gradient_by t lanes[11] x z
  return #[n.x, n.y, n.z, d.x, d.y, d.z, g.x, g.y, terrain.slope t x z]

entry const normals = fn (lanes: Array F32) -> Array F32 => do:
  let t = build lanes
  return array.flatten (array.generate (F32.to_u32 lanes[9]) (normal_row t lanes))

// lanes[11] lift, lanes[12] reach; rows are x, y, z
const stand_row = fn (t: Terrain) => fn (lanes: Array F32) => fn (i: U32) => do:
  let p = #Vec3 { x: lanes[16 + i * 3], y: lanes[17 + i * 3], z: lanes[18 + i * 3] }
  let a = terrain.stand t p lanes[11]
  let b = terrain.stick t p lanes[11] lanes[12]
  return #[a.position.x, a.position.y, a.position.z, (if a.grounded then 1.0 else 0.0), a.normal.x, a.normal.y, a.normal.z, b.position.y, (if b.grounded then 1.0 else 0.0)]

entry const stands = fn (lanes: Array F32) -> Array F32 => do:
  let t = build lanes
  return array.flatten (array.generate (F32.to_u32 lanes[9]) (stand_row t lanes))

// A character walking: lanes[11] is the lift of its origin above its feet and
// lanes[12] the reach that keeps it on the ground. One row: x, y, z, vx, vz,
// steps. Gravity pulls, terrain.stick holds it up. Reports where it ended up, how
// many steps after the first landing it was off the ground and whether it
// stands now.
entry const walk = fn (lanes: Array F32) -> Array F32 => do:
  let t = build lanes
  let lift = lanes[11]
  let reach = lanes[12]
  let pos = #Vec3 { x: lanes[16], y: lanes[17], z: lanes[18] }
  let vel = #Vec3 { x: lanes[19], y: 0.0, z: lanes[20] }
  let landed = #False
  let missed = 0.0
  let grounded = #False
  for step in 0..F32.to_u32 lanes[21]:
    vel.y := self - 20.0 / 60.0
    let moved = pos + vel * (1.0 / 60.0)
    let s = terrain.stick t moved lift (if grounded then reach else 0.0)
    pos := s.position
    grounded := s.grounded
    if s.grounded:
      landed := #True
      if vel.y < 0.0:
        vel.y := 0.0
    else:
      if landed:
        missed := self + 1.0
  return #[pos.x, pos.y, pos.z, vel.y, missed, (if grounded then 1.0 else 0.0)]

// rows are x0, z0, x1, z1
entry const ranges = fn (lanes: Array F32) -> Array F32 => do:
  let t = build lanes
  let one = fn (i: U32) => do:
    let (low, high) = terrain.range t lanes[16 + i * 4] lanes[17 + i * 4] lanes[18 + i * 4] lanes[19 + i * 4]
    return #[low, high]
  return array.flatten (array.generate (F32.to_u32 lanes[9]) one)

// Noise: lanes 0 seed, 1 octaves, 2 count; rows are x, y, z.
const noise_row = fn (lanes: Array F32) => fn (i: U32) => do:
  let seed = F32.to_u32 lanes[0]
  let p = #Vec3 { x: lanes[3 + i * 3], y: lanes[4 + i * 3], z: lanes[5 + i * 3] }
  return #[noise.perlin3 seed p, noise.fbm2 seed (F32.to_u32 lanes[1]) (#Vec2 { x: p.x, y: p.y })]

entry const noises = fn (lanes: Array F32) -> Array F32 =>
  array.flatten (array.generate (F32.to_u32 lanes[2]) (noise_row lanes))

// Lattice hashes: lanes 0 seed, 1 count; rows are x, y.
entry const hashes = fn (lanes: Array F32) -> Array F32 =>
  array.generate (F32.to_u32 lanes[1]) (fn (i: U32) => noise.at (F32.to_u32 lanes[0]) (F32.to_u32 lanes[2 + i * 2]) (F32.to_u32 lanes[3 + i * 2]))
`;

const dir = await Deno.makeTempDir({ prefix: "ink-terrain-" });
const entry = join(dir, "main.blot");
await Deno.writeTextFile(entry, source);
const compiler = await createCompiler({
  entry,
  imports: { "ink/": fromFileUrl(libraryUrl) },
});
const built = await compiler.build();
assert(built.success, JSON.stringify(built));
const guest = await instantiateGuest(built.bytes);

// A terrain to query: the CPU data and what the component would hold.
interface Scene {
  name: string;
  origin: [number, number, number];
  field: Heightfield;
  params: TerrainParams;
  /** Cells of the grid game code sees. */
  cells: number;
  grid: Float32Array;
}

function wavy(cells: number, phase: number): Heightfield {
  const field = Heightfield.create(cells);
  const s = field.stride;
  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) {
      field.heights[z * s + x] = 6 * Math.sin(x * 0.21 + phase) *
          Math.cos(z * 0.17 - phase) +
        0.8 * Math.sin(x * 1.3 + z * 0.9) +
        0.02 * x;
    }
  }
  return field;
}

function scene(
  name: string,
  origin: [number, number, number],
  cells: number,
  size: number,
  heightScale: number,
  detail: TerrainDetail,
  fieldCells = cells,
): Scene {
  const field = wavy(fieldCells, size);
  const params = { size, heightScale, detail };
  return {
    name,
    origin,
    field,
    params,
    cells,
    grid: collisionGrid(field, params, cells),
  };
}

const scenes: Scene[] = [
  scene("default detail", [0, 0, 0], 64, 512, 2, {
    seed: 1,
    amplitude: 1,
    wavelength: 6,
    octaves: 3,
  }),
  scene("moved, fine octaves", [10, 5, -20], 32, 100, 0.5, {
    seed: 77,
    amplitude: 1,
    wavelength: 3.7,
    octaves: 5,
  }),
  scene("kilometres wide", [-300, -2, 400], 128, 2048, 1, {
    seed: 123456,
    amplitude: 0.35,
    wavelength: 11,
    octaves: 1,
  }),
  scene("no amplitude", [3, 1, 3], 16, 64, 1.5, {
    seed: 9,
    amplitude: 0,
    wavelength: 6,
    octaves: 3,
  }),
  scene("no octaves", [0, 0, 0], 16, 64, 1, {
    seed: 9,
    amplitude: 1,
    wavelength: 6,
    octaves: 0,
  }),
  scene("six octaves, other seed", [-40, 12, 25], 48, 300, 1, {
    seed: 4093,
    amplitude: 1,
    wavelength: 20,
    octaves: 6,
  }),
];

function lanesFor(
  s: Scene,
  rows: number[][],
  extra: [number, number] = [0, 0],
  grid: Float32Array | number[] = s.grid,
): Float32Array {
  const width = rows[0]?.length ?? 0;
  const header = [
    ...s.origin,
    s.params.size,
    s.cells,
    s.params.detail.amplitude,
    s.params.detail.wavelength,
    s.params.detail.octaves,
    s.params.detail.seed,
    rows.length,
    width,
    extra[0],
    extra[1],
    0,
    0,
    0,
  ];
  return new Float32Array([...header, ...rows.flat(), ...grid]);
}

function call(entryName: string, lanes: Float32Array): Float32Array {
  return guest.call(entryName, lanes) as Float32Array;
}

/** Deterministic pseudo-random numbers in [0, 1). */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Terrain-local positions worth asking about: vertices, cell edges, the
 * border, outside the square, negatives, and scattered points. */
function locals(s: Scene, n = 160): [number, number][] {
  const half = s.params.size / 2;
  const cell = s.params.size / s.cells;
  const out: [number, number][] = [
    [0, 0],
    [-half, -half],
    [half, half],
    [-half, half],
    [half, -half],
    [half - cell, -half + cell],
    [cell * 0.5, cell * 0.5],
    [-cell * 0.25, cell * 3.75],
    [-half * 1.5, 0],
    [0, half * 2.5],
    [half * 3, -half * 3],
    [-half - 0.001, half + 0.001],
    [1e-4, -1e-4],
  ];
  // Exact grid vertices and the middle of a cell.
  for (const [i, j] of [[0, 0], [1, 0], [0, 1], [5, 7], [s.cells, s.cells]]) {
    out.push([-half + i * cell, -half + j * cell]);
    out.push([-half + (i + 0.5) * cell, -half + (j + 0.5) * cell]);
  }
  const next = random(s.cells * 31 + s.params.detail.seed);
  while (out.length < n) {
    out.push([
      (next() * 1.4 - 0.7) * s.params.size,
      (next() * 1.4 - 0.7) * s.params.size,
    ]);
  }
  return out;
}

const world = (s: Scene, [x, z]: [number, number]): [number, number] => [
  Math.fround(Math.fround(s.origin[0]) + x),
  Math.fround(Math.fround(s.origin[2]) + z),
];

/** What the CPU says the ground height is at a world position. */
function expectedHeight(s: Scene, x: number, z: number): number {
  return s.origin[1] + terrainHeightAt(
    s.field,
    s.params,
    x - Math.fround(s.origin[0]),
    z - Math.fround(s.origin[2]),
  );
}

Deno.test("the detail noise of ink/noise matches the TypeScript port", () => {
  const next = random(5);
  for (const seed of [0, 1, 7, 4093]) {
    const rows: number[][] = [];
    for (let i = 0; i < 250; i++) {
      const big = i % 10 === 0 ? 400 : 20;
      rows.push([
        (next() * 2 - 1) * big,
        (next() * 2 - 1) * big,
        (next() * 2 - 1) * 3,
      ]);
    }
    rows.push([0, 0, 0], [-1, -1, 0.5], [3, -7, 0.5], [-0.25, 0.75, -0.5]);
    for (const octaves of [1, 3, 6]) {
      const out = call(
        "noises",
        new Float32Array([seed, octaves, rows.length, ...rows.flat()]),
      );
      rows.forEach(([x, y, z], i) => {
        const fx = Math.fround(x), fy = Math.fround(y), fz = Math.fround(z);
        assertAlmostEquals(
          out[i * 2],
          perlin3(seed, fx, fy, fz),
          1e-4,
          `perlin3 seed ${seed} at ${fx}, ${fy}, ${fz}`,
        );
        assertAlmostEquals(
          out[i * 2 + 1],
          terrainNoise(seed, octaves, fx, fy),
          1e-4,
          `fbm2 seed ${seed} octaves ${octaves} at ${fx}, ${fy}`,
        );
      });
    }
  }
});

Deno.test("lattice hashes of ink/noise match the TypeScript port", () => {
  const rows: number[][] = [];
  for (let x = 0; x < 40; x++) {
    for (let y = 0; y < 40; y++) rows.push([x * 37 % 2000, y * 53 % 2000]);
  }
  for (const seed of [0, 1, 101, 202, 4093]) {
    const out = call(
      "hashes",
      new Float32Array([seed, rows.length, ...rows.flat()]),
    );
    rows.forEach(([x, y], i) => {
      // `at` keeps the top 24 bits of the hash as a fraction.
      const expected = (noiseHash3(x, y, 0, seed) >>> 8) / 16777216;
      assertEquals(out[i], Math.fround(expected), `hash ${x}, ${y}, ${seed}`);
    });
  }
});

Deno.test("terrain.height matches the CPU height function", () => {
  for (const s of scenes) {
    const queries = locals(s).map((l) => world(s, l));
    const rows = queries.map(([x, z]) => [x, z, s.origin[1] + 5]);
    const out = call("heights", lanesFor(s, rows));
    queries.forEach(([x, z], i) => {
      const want = expectedHeight(s, x, z);
      assertAlmostEquals(
        out[i * 4],
        want,
        1e-3,
        `${s.name}: height at ${x}, ${z}`,
      );
      // `ground` replaces y by the height; `above` measures against it.
      assertEquals(out[i * 4 + 2], out[i * 4]);
      assertAlmostEquals(out[i * 4 + 3], s.origin[1] + 5 - out[i * 4], 1e-4);
    });
  }
});

Deno.test("terrain.inside covers the square and nothing else", () => {
  const s = scenes[1];
  const half = s.params.size / 2;
  const [ox, , oz] = s.origin;
  const cases: [number, number, boolean][] = [
    [ox, oz, true],
    [ox + half, oz + half, true],
    [ox - half, oz - half, true],
    [ox + half + 0.01, oz, false],
    [ox, oz - half - 0.01, false],
    [ox + 3 * half, oz - 3 * half, false],
    [ox - half * 0.5, oz + half * 0.5, true],
  ];
  const out = call(
    "heights",
    lanesFor(s, cases.map(([x, z]) => [x, z, 0])),
  );
  cases.forEach(([x, z, inside], i) => {
    assertEquals(out[i * 4 + 1] === 1, inside, `inside ${x}, ${z}`);
  });
});

Deno.test("a coarse collision grid follows a fine heightfield", () => {
  // 256 field cells, a grid of 64: the guest only ever sees the grid, and on a
  // smooth hill it is within a few centimetres of the full resolution ground.
  const field = Heightfield.create(256);
  const s = field.stride;
  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) {
      field.heights[z * s + x] = 4 * Math.sin(x * 0.03) * Math.cos(z * 0.025) +
        0.01 * z;
    }
  }
  const params: TerrainParams = {
    size: 1024,
    heightScale: 1.5,
    detail: { seed: 3, amplitude: 0.7, wavelength: 9, octaves: 4 },
  };
  const coarse = scene("coarse", [0, 0, 0], 64, 1024, 1.5, params.detail);
  const grid = collisionGrid(field, params, 64);
  const fine: Scene = { ...coarse, field, grid };
  assertEquals(grid.length, 65 * 65);
  const queries = locals(fine, 200).map((l) => world(fine, l));
  const out = call(
    "heights",
    lanesFor(fine, queries.map(([x, z]) => [x, z, 0])),
  );
  queries.forEach(([x, z], i) => {
    // The same grid as a heightfield of its own is exact...
    const sameGrid = new Heightfield(
      64,
      grid.map((v) => v / 1.5),
      1,
      1,
      new Uint8Array(4),
    );
    assertAlmostEquals(
      out[i * 4],
      terrainHeightAt(sameGrid, params, x, z),
      1e-3,
      `grid height at ${x}, ${z}`,
    );
    // ...and close to the fine one.
    assertAlmostEquals(out[i * 4], terrainHeightAt(field, params, x, z), 0.03);
  });
});

Deno.test("terrain.normal, gradient and slope match the CPU normal", () => {
  for (const s of scenes) {
    const queries = locals(s, 100).map((l) => world(s, l));
    for (const step of [0.5, 2, 0.1]) {
      const rows = queries.map(([x, z]) => [x, z]);
      const out = call("normals", lanesFor(s, rows, [step, 0]));
      queries.forEach(([x, z], i) => {
        const [nx, ny, nz] = terrainNormalAt(
          s.field,
          s.params,
          x - Math.fround(s.origin[0]),
          z - Math.fround(s.origin[2]),
          step,
        );
        const o = i * 9;
        const where = `${s.name}: step ${step} at ${x}, ${z}`;
        // A small step amplifies float rounding of the heights.
        const tolerance = step < 0.2 ? 0.05 : 2e-3;
        assertAlmostEquals(out[o], nx, tolerance, `nx ${where}`);
        assertAlmostEquals(out[o + 1], ny, tolerance, `ny ${where}`);
        assertAlmostEquals(out[o + 2], nz, tolerance, `nz ${where}`);
        assertAlmostEquals(
          Math.hypot(out[o], out[o + 1], out[o + 2]),
          1,
          1e-5,
        );
        // The gradient is minus the normal's sideways part over its y.
        assertAlmostEquals(out[o + 6], -nx / ny, tolerance * 4, `gx ${where}`);
        assertAlmostEquals(out[o + 7], -nz / ny, tolerance * 4, `gz ${where}`);
        if (step === 0.5) {
          // `normal` and `slope` are the half metre versions.
          assertEquals([out[o + 3], out[o + 4], out[o + 5]], [
            out[o],
            out[o + 1],
            out[o + 2],
          ]);
          assertAlmostEquals(out[o + 8], Math.hypot(nx, nz) / ny, 8e-3);
        }
      });
    }
  }
});

Deno.test("a flat ground has an up normal and no slope", () => {
  const flat = scene("flat", [0, 3, 0], 8, 32, 1, {
    seed: 1,
    amplitude: 0,
    wavelength: 6,
    octaves: 3,
  });
  flat.field.heights.fill(2);
  const grid = collisionGrid(flat.field, flat.params, 8);
  const out = call(
    "normals",
    lanesFor({ ...flat, grid }, [[1, 2], [-30, 30], [100, 100]], [0.5, 0]),
  );
  for (let i = 0; i < 3; i++) {
    assertEquals(
      Array.from(out.slice(i * 9, i * 9 + 3)),
      [0, 1, 0],
    );
    assertEquals(out[i * 9 + 8], 0);
  }
});

Deno.test("terrain.stand lifts a body onto the ground and leaves a falling one alone", () => {
  const s = scenes[1];
  const lift = 0.9;
  const spots = locals(s, 40).map((l) => world(s, l));
  const ground = spots.map(([x, z]) => expectedHeight(s, x, z));
  // Per spot: far above, just above, resting, a little sunk, deep inside.
  const heights = [10, 0.05, 0, -0.2, -30];
  const rows: number[][] = [];
  const want: { y: number; spot: number; dy: number }[] = [];
  spots.forEach(([x, z], spot) =>
    heights.forEach((dy) => {
      rows.push([x, ground[spot] + lift + dy, z]);
      want.push({ y: ground[spot] + lift + dy, spot, dy });
    })
  );
  const out = call("stands", lanesFor(s, rows, [lift, 0.2]));
  want.forEach(({ spot, dy }, i) => {
    const o = i * 9;
    const [x, z] = spots[spot];
    const label = `spot ${x}, ${z}, ${dy} above rest`;
    const resting = ground[spot] + lift;
    // x and z never change.
    assertEquals(out[o], x);
    assertEquals(out[o + 2], z);
    if (dy > 0.002) {
      assertEquals(out[o + 3], 0, `airborne: ${label}`);
      assertAlmostEquals(out[o + 1], resting + dy, 1e-3, label);
      assertEquals(
        [out[o + 4], out[o + 5], out[o + 6]],
        [0, 1, 0],
        "an airborne body reports an up normal",
      );
    } else {
      assertEquals(out[o + 3], 1, `grounded: ${label}`);
      assertAlmostEquals(out[o + 1], resting, 1e-3, label);
      assert(out[o + 5] > 0 && out[o + 5] <= 1);
    }
    // `stick` with a reach of 0.2 also holds a body 0.05 above, not 10.
    const sticks = dy <= 0.2;
    assertEquals(out[o + 8], sticks ? 1 : 0, `stick ${label}`);
    assertAlmostEquals(
      out[o + 7],
      sticks ? resting : resting + dy,
      1e-3,
      `stick ${label}`,
    );
  });
});

Deno.test("terrain.range bounds the ground over a rectangle", () => {
  for (const s of scenes) {
    const half = s.params.size / 2;
    const next = random(s.cells + 11);
    const rects: [number, number, number, number][] = [];
    // Whole terrain, a sliver across a cell edge, points, outside, random.
    rects.push([-half, -half, half, half]);
    rects.push([-half * 2, -half * 2, half * 2, half * 2]);
    rects.push([half * 1.2, 0, half * 2, 5]);
    rects.push([0, 0, 0, 0]);
    rects.push([-half, -half, -half, -half]);
    for (let i = 0; i < 60; i++) {
      const x0 = (next() * 1.6 - 0.8) * half;
      const z0 = (next() * 1.6 - 0.8) * half;
      const w = next() * next() * half * 0.6;
      const d = next() * next() * half * 0.6;
      rects.push([x0, z0, x0 + w, z0 + d]);
    }
    const worldRects = rects.map(([x0, z0, x1, z1]) => [
      ...world(s, [x0, z0]),
      ...world(s, [x1, z1]),
    ]);
    const out = call("ranges", lanesFor(s, worldRects));
    worldRects.forEach(([x0, z0, x1, z1], i) => {
      const low = out[i * 2], high = out[i * 2 + 1];
      assert(low <= high, `${s.name}: ordered`);
      // Every ground height inside the rectangle is within the bounds.
      for (let a = 0; a <= 8; a++) {
        for (let b = 0; b <= 8; b++) {
          const x = x0 + (x1 - x0) * a / 8, z = z0 + (z1 - z0) * b / 8;
          const h = expectedHeight(s, x, z);
          assert(
            h >= low - 1e-3 && h <= high + 1e-3,
            `${s.name}: ${h} outside [${low}, ${high}] at ${x}, ${z}`,
          );
        }
      }
    });
  }

  // Without detail the bound is the extremes of the grid samples under the
  // rectangle: tight enough to prune with.
  const s = scenes[3];
  const cell = s.params.size / s.cells;
  const half = s.params.size / 2;
  const at = (i: number, j: number) =>
    s.origin[1] + s.grid[j * (s.cells + 1) + i];
  // Inside the cell (4, 6): its four corners.
  const x0 = s.origin[0] - half + 4.2 * cell,
    z0 = s.origin[2] - half + 6.3 * cell;
  const out = call(
    "ranges",
    lanesFor(s, [[x0, z0, x0 + cell * 0.5, z0 + cell * 0.4]]),
  );
  const corners = [at(4, 6), at(5, 6), at(4, 7), at(5, 7)];
  assertAlmostEquals(out[0], Math.min(...corners), 1e-4);
  assertAlmostEquals(out[1], Math.max(...corners), 1e-4);
});

Deno.test("a character keeps its footing walking down a slope with stick", () => {
  // A 0.3 slope falling toward +x, walked down at 6 m/s: the ground drops
  // faster than gravity pulls a standing body, so only `reach` holds it on.
  const ramp = scene("ramp", [0, 0, 0], 32, 64, 1, {
    seed: 1,
    amplitude: 0,
    wavelength: 6,
    octaves: 3,
  });
  const s = ramp.field.stride;
  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) {
      ramp.field.heights[z * s + x] = -0.3 * (x * 2 - 32);
    }
  }
  const grid = collisionGrid(ramp.field, ramp.params, 32);
  const lift = 0.9;
  const walk = (reach: number) =>
    call(
      "walk",
      lanesFor({ ...ramp, grid }, [[-20, 8, 3, 6, 0.5, 300]], [lift, reach]),
    );
  const held = walk(0.25);
  const hopping = walk(0);
  // The walker covers the distance, ends on the ground and was never off it.
  assertAlmostEquals(held[0], -20 + 6 * 5, 0.05);
  assertAlmostEquals(held[2], 3 + 0.5 * 5, 0.05);
  assertAlmostEquals(held[1] - lift, -0.3 * held[0], 2e-3);
  assertEquals(held[4], 0, "stuck to the slope");
  assertEquals(held[5], 1);
  // Without reach it leaves the ground over and over.
  assert(hopping[4] > 20, `hops ${hopping[4]} times`);
});

Deno.test("the detail is bounded by its amplitude in terrain.range", () => {
  // A flat grid: only the detail moves the ground, and the range must hold it.
  const s = scene("bound", [0, 0, 0], 8, 4096, 1, {
    seed: 21,
    amplitude: 3,
    wavelength: 5,
    octaves: 4,
  });
  s.field.heights.fill(0);
  const grid = collisionGrid(s.field, s.params, 8);
  const next = random(2);
  const rows: number[][] = [];
  for (let i = 0; i < 4000; i++) {
    rows.push([(next() - 0.5) * 3000, (next() - 0.5) * 3000, 0]);
  }
  const heights = call("heights", lanesFor({ ...s, grid }, rows));
  const [low, high] = call(
    "ranges",
    lanesFor({ ...s, grid }, [[-2048, -2048, 2048, 2048]]),
  );
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    min = Math.min(min, heights[i * 4]);
    max = Math.max(max, heights[i * 4]);
  }
  assert(
    min >= low && max <= high,
    `[${min}, ${max}] within [${low}, ${high}]`,
  );
  // The noise does use most of its amplitude, so the bound is not loose.
  assert(max > 1.5 && min < -1.5, `[${min}, ${max}]`);
});

Deno.test("a missing grid is flat ground, not a crash", () => {
  const s = scenes[1];
  const rows = [[s.origin[0], s.origin[2], 0], [
    s.origin[0] + 9,
    s.origin[2] - 4,
    0,
  ]];
  for (const grid of [[], new Array(5).fill(7), s.grid.slice(0, 33 * 33 - 1)]) {
    const out = call("heights", lanesFor(s, rows, [0, 0], grid));
    rows.forEach(([x, z], i) => {
      // Ground at the origin's height plus the detail.
      const detail = terrainHeightAt(
        Heightfield.create(1),
        { ...s.params, heightScale: 0 },
        x - s.origin[0],
        z - s.origin[2],
      );
      assertAlmostEquals(out[i * 4], s.origin[1] + detail, 1e-3);
    });
    const range = call(
      "ranges",
      lanesFor(s, [[-50, -50, 50, 50]], [0, 0], grid),
    );
    assertAlmostEquals(
      range[0],
      s.origin[1] - 1.04 * s.params.detail.amplitude,
      1e-4,
    );
    assertAlmostEquals(
      range[1],
      s.origin[1] + 1.04 * s.params.detail.amplitude,
      1e-4,
    );
  }
});

// The code docs/blot.md shows: a walker follows the ground of a terrain
// component, read from the world with the generated schema.
const gameSource = `import * as array from "std/array"
import * as s from "./schema.gen"
import * as terrain from "ink/terrain"

// The first terrain in the world, ready to be asked about the ground.
const find_ground = fn (world: s.World) => do:
  for e in world.entities:
    if let #Some c = e.terrain:
      if let #Some t = e.transform:
        return #Some (terrain.make t.position c.size c.collision_cells c.grid c.detail_amplitude c.detail_wavelength c.detail_octaves c.detail_seed)
  return #Nothing

const walk = fn (input: s.Input) => fn (ground: terrain.Terrain) => fn (entity: s.Entity) => do:
  let #Some body = entity.walker else:
    return entity
  let #Some t = entity.transform else:
    return entity
  body.velocity.y := self - body.gravity * input.dt
  let moved = t.position + body.velocity * input.dt
  let reach = if body.grounded then 0.3 else 0.0
  let stood = terrain.stick ground moved 0.9 reach
  if stood.grounded && body.velocity.y < 0.0:
    body.velocity.y := 0.0
  t.position := stood.position
  body.grounded := stood.grounded
  entity.walker := #Some body
  entity.transform := #Some t
  return entity

const update = fn (input: s.Input) => fn (world: s.World) => do:
  let #Some ground = find_ground world else:
    return world
  world.entities := array.map (walk input ground) self
  return world

entry const step = fn (lanes: Array F32) -> Array F32 => s.run update lanes
`;

Deno.test("game code reads a terrain component and walks on it", async () => {
  const schema = defineSchema({
    components: {
      transform: standard.transform,
      ...standard.componentsWorld,
      walker: {
        velocity: vec3(),
        grounded: bool(),
        gravity: f32({ default: 20 }),
      },
    },
    resources: {},
    events: {},
    actions: {},
  });
  const catalog = {
    assets: { mesh: [], texture: [], sound: [], terrain: [] },
  };
  // A hill: the grid the terrain tools would keep in the component.
  const hill = scene("hill", [5, 1, -3], 16, 64, 1, {
    seed: 11,
    amplitude: 0.5,
    wavelength: 5,
    octaves: 3,
  });
  const dir = await Deno.makeTempDir({ prefix: "ink-terrain-game-" });
  try {
    const gameEntry = join(dir, "main.blot");
    await Deno.writeTextFile(gameEntry, gameSource);
    const gameCompiler = await createGameCompiler({
      entry: gameEntry,
      schema,
      catalog,
    });
    try {
      const result = await gameCompiler.build();
      if (!result.ok) {
        throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
      }
      const game = await loadGame(result.bytes, schema);
      const { world } = sceneToWorld(schema, {
        ink: 1,
        entities: [
          {
            id: 1,
            components: {
              transform: { position: hill.origin },
              terrain: {
                size: 64,
                collision_cells: 16,
                grid: Array.from(hill.grid),
                detail_amplitude: 0.5,
                detail_wavelength: 5,
                detail_octaves: 3,
                detail_seed: 11,
              },
            },
          },
          {
            id: 2,
            components: {
              transform: { position: [-8, 20, 4] },
              walker: { velocity: [3, 0, 1] },
            },
          },
        ],
      }, catalog);
      let state = encodeWorld(schema, world);
      const input = idleInput(schema, 0, 1 / 60);
      // Fall for a second, then walk for a few.
      for (let i = 0; i < 400; i++) state = game.step(state, input).state;
      const walker = decodeWorld(schema, state).entities[1].components;
      const [x, y, z] = walker.transform.position as number[];
      assertAlmostEquals(x, -8 + 3 * 400 / 60, 0.05);
      assertAlmostEquals(z, 4 + 400 / 60, 0.05);
      assertEquals((walker.walker as { grounded: boolean }).grounded, true);
      // Its feet (0.9 below its origin) stand on the ground the CPU computes.
      assertAlmostEquals(
        y - 0.9,
        expectedHeight(hill, Math.fround(x), Math.fround(z)),
        2e-3,
      );
      game.dispose();
    } finally {
      await gameCompiler.dispose();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("heights cost little per call", () => {
  const s = scenes[0];
  const queries = locals(s, 1000).map((l) => world(s, l));
  const lanes = lanesFor(s, queries.map(([x, z]) => [x, z, 0]));
  call("heights", lanes);
  const rounds = 20;
  const started = performance.now();
  for (let i = 0; i < rounds; i++) call("heights", lanes);
  const perCall = (performance.now() - started) / rounds / queries.length;
  console.log(
    `  height + inside + ground + above: ${
      (perCall * 1e6).toFixed(0)
    } ns per row`,
  );
  // Generous: this runs on shared CI machines (SwiftShader and all).
  assert(perCall < 0.02, `${perCall} ms per row`);
});

Deno.test.afterAll(async () => {
  guest.dispose();
  await compiler.dispose();
  await Deno.remove(dir, { recursive: true });
});
