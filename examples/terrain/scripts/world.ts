/**
 * The terrain gate world: a 2 km square of mountains, hills, a river valley, a
 * lake and plains, generated from fixed noise so every run (and every machine)
 * writes the same bytes. The generators, the scene and the tests all build on
 * this module.
 *
 * Coordinates: terrain-local metres from the centre, +x east, +z south; the
 * stored field is row-major with row = z from the -z edge.
 */
import {
  Heightfield,
  terrainHeightAt,
  terrainNormalAt,
  type TerrainParams,
} from "@ink/geometry";

export const WORLD_SIZE = 2048;
export const WORLD_CELLS = 2048;
export const SPLAT_CELLS = 1024;
/** Sea level of lake and river, metres. Everything below it is water. */
export const WATER_LEVEL = 6;

/** Splat layers, in the order of the terrain component's `layers` list. */
export const LAYERS = ["grass", "rock", "dirt", "sand"] as const;
export const GRASS = 0, ROCK = 1, DIRT = 2, SAND = 3;
/** World size of one texture repeat, metres, per layer. */
export const TILING = [4, 6, 3, 4];

export const DETAIL = {
  seed: 1,
  amplitude: 0.35,
  wavelength: 6,
  octaves: 3,
};

export const terrainParamsFor = (size = WORLD_SIZE): TerrainParams => ({
  size,
  heightScale: 1,
  detail: DETAIL,
});

// Random numbers and noise ------------------------------------------------------

/** mulberry32: a small deterministic generator. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const perm = (() => {
  const random = rng(0x1ee7);
  const table = new Uint8Array(256).map((_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [table[i], table[j]] = [table[j], table[i]];
  }
  const doubled = new Uint8Array(512);
  doubled.set(table);
  doubled.set(table, 256);
  return doubled;
})();

const S = Math.SQRT1_2;
// Eight gradient directions as a flat array: x0, y0, x1, y1, ...
const gradients = new Float64Array([
  1,
  0,
  -1,
  0,
  0,
  1,
  0,
  -1,
  S,
  S,
  -S,
  S,
  S,
  -S,
  -S,
  -S,
]);

/** 2D gradient noise, about [-1, 1], lattice repeating every 256 cells. */
export function noise2(x: number, y: number): number {
  const fx = Math.floor(x), fy = Math.floor(y);
  const xf = x - fx, yf = y - fy;
  const X = fx & 255, Y = fy & 255;
  const a = perm[X] + Y, b = perm[X + 1] + Y;
  const g00 = (perm[a] & 7) << 1, g10 = (perm[b] & 7) << 1;
  const g01 = (perm[a + 1] & 7) << 1, g11 = (perm[b + 1] & 7) << 1;
  const n00 = gradients[g00] * xf + gradients[g00 + 1] * yf;
  const n10 = gradients[g10] * (xf - 1) + gradients[g10 + 1] * yf;
  const n01 = gradients[g01] * xf + gradients[g01 + 1] * (yf - 1);
  const n11 = gradients[g11] * (xf - 1) + gradients[g11 + 1] * (yf - 1);
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const top = n00 + (n10 - n00) * u, bottom = n01 + (n11 - n01) * u;
  return (top + (bottom - top) * v) * 1.4142;
}

/** Fractal sum of `noise2`, about [-1, 1]. `salt` decorrelates fields. */
export function fbm(
  x: number,
  y: number,
  octaves: number,
  salt = 0,
): number {
  let sum = 0, amplitude = 1, total = 0;
  x += salt * 37.31;
  y += salt * 91.77;
  for (let o = 0; o < octaves; o++) {
    sum += amplitude * noise2(x, y);
    total += amplitude;
    amplitude *= 0.5;
    x = x * 2 + 17.3;
    y = y * 2 + 5.1;
  }
  return sum / total;
}

const noiseOut = new Float64Array(3);

/** `noise2` with its analytic gradient: `out` is [value, d/dx, d/dy]. */
function noised(x: number, y: number, out: Float64Array): void {
  const fx = Math.floor(x), fy = Math.floor(y);
  const xf = x - fx, yf = y - fy;
  const X = fx & 255, Y = fy & 255;
  const a = perm[X] + Y, b = perm[X + 1] + Y;
  const g00 = (perm[a] & 7) << 1, g10 = (perm[b] & 7) << 1;
  const g01 = (perm[a + 1] & 7) << 1, g11 = (perm[b + 1] & 7) << 1;
  const ax = gradients[g00], ay = gradients[g00 + 1];
  const bx = gradients[g10], by = gradients[g10 + 1];
  const cx = gradients[g01], cy = gradients[g01 + 1];
  const dx = gradients[g11], dy = gradients[g11 + 1];
  const n00 = ax * xf + ay * yf;
  const n10 = bx * (xf - 1) + by * yf;
  const n01 = cx * xf + cy * (yf - 1);
  const n11 = dx * (xf - 1) + dy * (yf - 1);
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const du = 30 * xf * xf * (xf - 1) * (xf - 1);
  const dv = 30 * yf * yf * (yf - 1) * (yf - 1);
  const k = n00 - n10 - n01 + n11;
  out[0] = (n00 + u * (n10 - n00) + v * (n01 - n00) + u * v * k) * 1.4142;
  out[1] = (ax + u * (bx - ax) + v * (cx - ax) + u * v * (ax - bx - cx + dx) +
    du * (n10 - n00 + v * k)) * 1.4142;
  out[2] = (ay + u * (by - ay) + v * (cy - ay) + u * v * (ay - by - cy + dy) +
    dv * (n01 - n00 + u * k)) * 1.4142;
}

/**
 * Erosion-like fractal noise, about [-1, 1]: each octave is damped by the
 * slope the coarser ones already built, so slopes stay smooth while valley
 * floors fill with detail, as water-worn ground does.
 */
export function eroded(
  x: number,
  y: number,
  octaves: number,
  salt = 0,
): number {
  let sum = 0, amplitude = 1, total = 0, gx = 0, gy = 0;
  x += salt * 43.13;
  y += salt * 71.07;
  for (let o = 0; o < octaves; o++) {
    noised(x, y, noiseOut);
    gx += noiseOut[1];
    gy += noiseOut[2];
    sum += amplitude * noiseOut[0] / (1 + gx * gx + gy * gy);
    total += amplitude;
    amplitude *= 0.5;
    // Rotate a little each octave so lattice axes do not line up.
    const rx = x * 1.6 - y * 1.2, ry = x * 1.2 + y * 1.6;
    x = rx + 13.7;
    y = ry + 8.1;
  }
  return sum / total;
}

/** Ridged multifractal in [0, 1]: crests and gullies, no pits. */
export function ridged(
  x: number,
  y: number,
  octaves: number,
  salt = 0,
): number {
  let sum = 0, amplitude = 1, total = 0;
  x += salt * 53.17;
  y += salt * 27.91;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(noise2(x, y));
    sum += n * n * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    x = x * 2 + 11.7;
    y = y * 2 + 3.9;
  }
  return sum / total;
}

export const clamp = (v: number, lo = 0, hi = 1) =>
  v < lo ? lo : v > hi ? hi : v;
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** Hermite step; also works with `edge0 > edge1` (a falling step). */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
/** Smooth minimum over `k` metres. */
const smin = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};

// The land ------------------------------------------------------------------------

export const LAKE = { x: -340, z: 380, radius: 200 };
/** The meadow the player starts in: gentle ground around the centre. */
const MEADOW = { x: 0, z: 0 };

/** x of the river's centre line at z. */
function riverX(z: number): number {
  const trend = mix(260, LAKE.x, smoothstep(-1100, LAKE.z, z));
  const meander = 150 * Math.sin(z / 240 + 0.4) + 52 * Math.sin(z / 87 + 1.7);
  return trend + meander * (1 - 0.8 * smoothstep(100, LAKE.z, z));
}

/** Distance to the river's centre line, metres (infinite below the lake). */
export function riverDistance(x: number, z: number): number {
  if (z > LAKE.z + 20) return Infinity;
  const slope = (riverX(z + 2) - riverX(z - 2)) / 4;
  return Math.abs(x - riverX(z)) / Math.sqrt(1 + slope * slope);
}

/** Distance from the lake centre in units of the lake's (noisy) radius. */
function lakeDistance(x: number, z: number): number {
  const dx = x - LAKE.x, dz = z - LAKE.z;
  const length = Math.hypot(dx, dz) || 1;
  const shore = 1 + 0.32 * fbm(dx / length * 1.3 + 4, dz / length * 1.3 + 9, 3);
  return length / (LAKE.radius * shore);
}

/** Ground height, metres, before the shader's detail noise. */
export function elevation(x: number, z: number): number {
  // Domain warp: keeps ridges and valleys from following the noise lattice.
  const wx = x + 110 * fbm(x / 800 + 11.3, z / 800 + 3.7, 2, 1);
  const wz = z + 110 * fbm(x / 800 - 7.1, z / 800 + 19.9, 2, 2);

  // Mountains rise in the north, the east and along the west edge.
  const north = smoothstep(-40, -760, z);
  const east = smoothstep(300, 900, x);
  const west = smoothstep(-640, -1000, x) * 0.8;
  const massif = 1 - (1 - north) * (1 - east) * (1 - west);
  const patchy = fbm(wx / 900, wz / 900, 3, 3);
  const mountains = smoothstep(0.25, 0.7, massif + 0.7 * patchy);
  // Broad domes carry the eroded crests, so ranges read as massifs.
  const dome = smoothstep(-0.25, 0.55, fbm(wx / 900, wz / 900, 3, 15));
  const rough = clamp(0.5 + 2.4 * eroded(wx / 650, wz / 650, 8, 4));
  const crest = clamp((ridged(wx / 420, wz / 420, 4, 5) - 0.4) / 0.45);
  const range = mountains *
    (24 + 60 * dome + 170 * rough * (0.3 + 0.8 * dome) +
      55 * dome * Math.pow(crest, 1.5) + 2.5 * fbm(wx / 32, wz / 32, 2, 16));

  // Low rolling country around the meadow, flattening out to plains south.
  const away = Math.hypot(x - MEADOW.x, z - MEADOW.z);
  const rolling = smoothstep(40, 300, away) *
    (1 - 0.55 * smoothstep(420, 900, z));
  const knolls = 0.5 + 0.5 * fbm(wx / 420, wz / 420, 4, 5);
  const hills = (105 * Math.pow(knolls, 1.6) +
    9 * fbm(wx / 170, wz / 170, 2, 17)) * rolling * (1 - mountains);

  const plain = 15 + 8 * fbm(wx / 560, wz / 560, 3, 6) +
    1.8 * fbm(x / 80, z / 80, 3, 7);
  let h = plain + hills + range;

  // The lake basin: a bowl that blends into the surrounding land.
  const lake = lakeDistance(x, z);
  if (lake < 1.9) {
    const bowl = WATER_LEVEL - 5.4 +
      12 * smoothstep(0.15, 1.35, lake) +
      0.6 * fbm(x / 60, z / 60, 2, 8);
    h = mix(Math.min(bowl, h), h, smoothstep(0.95, 1.9, lake));
  }

  // The river valley: a V-shaped cut whose floor stays under the water level
  // down by the lake and climbs towards the mountains upstream.
  const river = riverDistance(x, z);
  if (river < 400) {
    const upstream = Math.max(0, LAKE.z - z);
    const bed = WATER_LEVEL - 2 + 0.09 * Math.max(0, upstream - 700) +
      0.5 * fbm(x / 40, z / 40, 2, 9);
    const bank = Math.max(0, river - 7);
    const profile = bed + 0.22 * bank + 0.0018 * bank * bank +
      6 * fbm(x / 70, z / 70, 2, 10) * smoothstep(8, 45, river);
    h = smin(h, profile, 10);
  }
  // Soft ceiling: peaks flatten towards 226 m instead of clipping.
  if (h > 190) h = 190 + 36 * Math.tanh((h - 190) / 36);
  return clamp(h, 0, 226);
}

// Heightfield and splat map ---------------------------------------------------------

export interface WorldOptions {
  cells?: number;
  splatCells?: number;
  size?: number;
}

/** The whole world: heights from `elevation`, splat from height and slope. */
export function generateHeightfield(options: WorldOptions = {}): Heightfield {
  const cells = options.cells ?? WORLD_CELLS;
  const splatCells = options.splatCells ?? Math.max(1, cells >> 1);
  const size = options.size ?? WORLD_SIZE;
  const field = Heightfield.create(cells, { splatCells, layers: 4 });
  const stride = cells + 1, spacing = size / cells;
  for (let row = 0; row < stride; row++) {
    const z = row * spacing - size / 2;
    for (let col = 0; col < stride; col++) {
      field.heights[row * stride + col] = elevation(
        col * spacing - size / 2,
        z,
      );
    }
  }
  paintSplat(field, size);
  field.revision = 1;
  return field;
}

/** Layer weights at a spot: grass, rock, dirt, sand (they sum to 1). */
export function layerWeights(
  x: number,
  z: number,
  height: number,
  tan: number,
): [number, number, number, number] {
  const jag = fbm(x / 7, z / 7, 2, 11);
  // Sand: the lake and river shores and everything under water.
  const shoreline = WATER_LEVEL + 2.2 + 1.6 * fbm(x / 28, z / 28, 2, 12);
  const sand = (1 - smoothstep(WATER_LEVEL + 0.2, shoreline, height)) *
    (1 - smoothstep(0.25, 0.5, tan));
  // Rock: steep ground and the exposed heights.
  const steep = smoothstep(0.55 + 0.1 * jag, 0.95 + 0.1 * jag, tan);
  const alpine = 0.85 *
    smoothstep(105, 170, height + 24 * fbm(x / 80, z / 80, 3, 13));
  const rock = Math.max(steep, alpine) * (1 - sand);
  // Dirt: noisy patches, bare gravel on the river banks, and moderate slopes.
  const patches = smoothstep(0.12, 0.42, fbm(x / 55, z / 55, 3, 14));
  const bank = height < WATER_LEVEL + 7
    ? 0.8 * (1 - smoothstep(9, 30, riverDistance(x, z))) *
      (1 - smoothstep(0.1, 0.3, tan))
    : 0;
  const slope = 0.5 * smoothstep(0.28, 0.58, tan);
  const dirt = clamp(Math.max(patches * 0.9, bank, slope)) *
    (1 - sand) * (1 - rock);
  const grass = Math.max(0, 1 - sand - rock - dirt);
  const sum = grass + rock + dirt + sand || 1;
  return [grass / sum, rock / sum, dirt / sum, sand / sum];
}

function paintSplat(field: Heightfield, size: number) {
  const n = field.splatCells, ratio = field.cells / n, spacing = size / n;
  const meters = size / field.cells;
  for (let pz = 0; pz < n; pz++) {
    for (let px = 0; px < n; px++) {
      const u = (px + 0.5) * ratio, v = (pz + 0.5) * ratio;
      const height = field.sampleCell(u, v);
      const dx = (field.sampleCell(u + 1, v) - field.sampleCell(u - 1, v)) /
        (2 * meters);
      const dz = (field.sampleCell(u, v + 1) - field.sampleCell(u, v - 1)) /
        (2 * meters);
      const x = (px + 0.5) * spacing - size / 2;
      const z = (pz + 0.5) * spacing - size / 2;
      const w = layerWeights(x, z, height, Math.hypot(dx, dz));
      // Quantise so the four bytes sum to exactly 255.
      const bytes = w.map((value) => Math.floor(value * 255));
      let left = 255 - bytes[0] - bytes[1] - bytes[2] - bytes[3];
      const order = [0, 1, 2, 3].sort((a, b) =>
        (w[b] * 255 - bytes[b]) - (w[a] * 255 - bytes[a]) || a - b
      );
      for (let i = 0; left > 0; i = (i + 1) % 4, left--) bytes[order[i]]++;
      field.splat.set(bytes, (pz * n + px) * 4);
    }
  }
}

// Queries the generators share --------------------------------------------------------

/** Height of the world's ground at a spot (detail noise included). */
export const groundAt = (
  field: Heightfield,
  params: TerrainParams,
  x: number,
  z: number,
) => terrainHeightAt(field, params, x, z);

/** tan of the ground's slope angle at a spot. */
export function slopeAt(
  field: Heightfield,
  params: TerrainParams,
  x: number,
  z: number,
): number {
  const normal = terrainNormalAt(field, params, x, z, 1);
  return Math.hypot(normal[0], normal[2]) / normal[1];
}

/** Splat weight (0..1) of a layer at a terrain-local spot. */
export function layerAt(
  field: Heightfield,
  params: TerrainParams,
  layer: number,
  x: number,
  z: number,
): number {
  const f = field.cells / params.size;
  return field.splatAt(
    layer,
    (x + params.size / 2) * f,
    (z + params.size / 2) * f,
  );
}

/**
 * Where the player starts: the meadow spot closest to the centre that is
 * level, grassy, dry and away from the river. Deterministic given the field.
 */
export function findSpawn(
  field: Heightfield,
  params: TerrainParams,
): [number, number] {
  const probe = (x: number, z: number) => {
    const height = groundAt(field, params, x, z);
    if (height < WATER_LEVEL + 5 || height > 70) return false;
    if (riverDistance(x, z) < 90 || lakeDistance(x, z) < 1.6) return false;
    for (let a = 0; a < 8; a++) {
      const r = a === 0 ? 0 : 14;
      const px = x + Math.cos(a * Math.PI / 4) * r;
      const pz = z + Math.sin(a * Math.PI / 4) * r;
      if (slopeAt(field, params, px, pz) > 0.12) return false;
      if (layerAt(field, params, GRASS, px, pz) < 0.85) return false;
    }
    return true;
  };
  for (let radius = 0; radius <= 700; radius += 10) {
    const steps = Math.max(1, Math.round(radius * Math.PI * 2 / 10));
    for (let i = 0; i < steps; i++) {
      const angle = i / steps * Math.PI * 2 + 0.7;
      const x = MEADOW.x + Math.cos(angle) * radius;
      const z = MEADOW.z + Math.sin(angle) * radius;
      if (probe(x, z)) return [x, z];
    }
  }
  return [MEADOW.x, MEADOW.z];
}
