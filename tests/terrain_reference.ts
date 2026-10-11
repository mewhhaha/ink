/** Test-only numerical reference. No scene, rendering or file-format code. */
export interface TerrainParams {
  /** Side length in metres. */
  size: number;
  heightScale: number;
  detail: TerrainDetail;
}

export interface TerrainDetail {
  seed: number;
  /** Peak height of the first octave, metres. 0 disables the detail. */
  amplitude: number;
  /** Wavelength of the first octave, metres. */
  wavelength: number;
  octaves: number;
}

export function noiseHash3(
  x: number,
  y: number,
  z: number,
  seed: number,
): number {
  let h = Math.imul(x, 2747636419 | 0) ^ Math.imul(y, 2654435769 | 0) ^
    Math.imul(z, 2246822519 | 0) ^ Math.imul(seed, 3266489917 | 0);
  h = h ^ (h >>> 15);
  h = Math.imul(h, 2246822507 | 0);
  h = h ^ (h >>> 13);
  h = Math.imul(h, 3266489909 | 0);
  return (h ^ (h >>> 16)) >>> 0;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function gradient(h: number, x: number, y: number, z: number): number {
  const k = h % 12;
  let u = y;
  if (k < 8) u = x;
  let v = z;
  if (k < 4) v = y;
  if ((k & 1) !== 0) u = -u;
  if ((k & 2) !== 0) v = -v;
  return u + v;
}

/** `ink/noise` `perlin3`. */
export function perlin3(
  seed: number,
  x: number,
  y: number,
  z: number,
): number {
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  const xi = fx | 0, yi = fy | 0, zi = fz | 0;
  const xf = x - fx, yf = y - fy, zf = z - fz;
  const g = (i: number, j: number, k: number) =>
    gradient(noiseHash3(xi + i, yi + j, zi + k, seed), xf - i, yf - j, zf - k);
  const u = fade(xf), v = fade(yf), w = fade(zf);
  const x00 = lerp(g(0, 0, 0), g(1, 0, 0), u);
  const x10 = lerp(g(0, 1, 0), g(1, 1, 0), u);
  const x01 = lerp(g(0, 0, 1), g(1, 0, 1), u);
  const x11 = lerp(g(0, 1, 1), g(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}

/** Independent double-precision reference for the fractal sum. */
export function terrainNoise(
  seed: number,
  octaves: number,
  x: number,
  y: number,
): number {
  let sum = 0, total = 0, amplitude = 1, frequency = 1;
  for (let octave = 0; octave < octaves; octave++) {
    sum += amplitude *
      perlin3(seed + octave * 101, x * frequency, y * frequency, 0.5);
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  if (total === 0) return 0;
  return sum / total;
}

/** Procedural detail height at a terrain-local position, metres. */
export function terrainDetail(
  detail: TerrainDetail,
  x: number,
  z: number,
): number {
  if (detail.amplitude === 0 || detail.octaves <= 0) return 0;
  const f = 1 / Math.max(1e-3, detail.wavelength);
  return detail.amplitude *
    terrainNoise(detail.seed, detail.octaves, x * f, z * f);
}

export class Heightfield {
  readonly stride: number;

  constructor(readonly cells: number, readonly heights: Float32Array) {
    this.stride = cells + 1;
  }

  static create(cells: number): Heightfield {
    return new Heightfield(cells, new Float32Array((cells + 1) ** 2));
  }

  sampleCell(x: number, z: number): number {
    const max = this.cells;
    const cx = Math.min(Math.max(x, 0), max),
      cz = Math.min(Math.max(z, 0), max);
    const x0 = Math.min(Math.floor(cx), max - 1),
      z0 = Math.min(Math.floor(cz), max - 1);
    const fx = cx - x0, fz = cz - z0, s = this.stride, h = this.heights;
    const i = z0 * s + x0;
    return lerp(
      lerp(h[i], h[i + 1], fx),
      lerp(h[i + s], h[i + s + 1], fx),
      fz,
    );
  }
}

export function terrainHeightAt(
  field: Heightfield,
  params: TerrainParams,
  x: number,
  z: number,
): number {
  const f = field.cells / params.size;
  const base = field.sampleCell(
    (x + params.size / 2) * f,
    (z + params.size / 2) * f,
  );
  return base * params.heightScale + terrainDetail(params.detail, x, z);
}

/** Unit normal of the ground at a terrain-local position, by central
 * differences `step` metres apart. */
export function terrainNormalAt(
  field: Heightfield,
  params: TerrainParams,
  x: number,
  z: number,
  step = 0.5,
): [number, number, number] {
  const dx = terrainHeightAt(field, params, x + step, z) -
    terrainHeightAt(field, params, x - step, z);
  const dz = terrainHeightAt(field, params, x, z + step) -
    terrainHeightAt(field, params, x, z - step);
  const nx = -dx / (2 * step), nz = -dz / (2 * step);
  const length = Math.hypot(nx, 1, nz);
  return [nx / length, 1 / length, nz / length];
}

export function collisionGrid(
  field: Heightfield,
  params: TerrainParams,
  cells: number,
): Float32Array {
  const stride = cells + 1;
  const out = new Float32Array(stride * stride);
  const ratio = field.cells / cells;
  for (let z = 0; z < stride; z++) {
    for (let x = 0; x < stride; x++) {
      out[z * stride + x] = field.sampleCell(x * ratio, z * ratio) *
        params.heightScale;
    }
  }
  return out;
}
