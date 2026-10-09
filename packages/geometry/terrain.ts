/**
 * Heightfield terrain: the data, its file format and the height function the
 * renderer, the tools and (through `ink/terrain`) game code agree on.
 *
 * A terrain is a square of `size` metres centred on its entity. The stored
 * field has `cells + 1` height samples per side (`f32`, metres before
 * `height_scale`) and a splat map of `splatCells` texels per side holding up
 * to eight layer weights (`u8`, four per plane). On top of the bilinear field
 * every terrain adds procedural detail, the same fractal Perlin noise as
 * `ink/noise` (see `terrainNoise`), so the CPU, the GPU and Blot compute the
 * same ground height.
 *
 * File layout (little endian), `*.terrain`:
 *   header 32 bytes: "INKT", version, cells, splatCells, layers, revision,
 *                    overviewCells, reserved
 *   overview  (overviewCells + 1)² f32: a decimated copy of the field, first
 *                    so a loader can show the whole terrain before the rest
 *                    arrives
 *   heights   (cells + 1)² f32, row-major (row = z, from the -z edge)
 *   splat     planes * splatCells² * 4 u8, plane after plane (row = z)
 */

const MAGIC = 0x544b4e49; // "INKT" little endian
export const TERRAIN_VERSION = 1;
export const TERRAIN_HEADER_BYTES = 32;
export const TERRAIN_MAX_LAYERS = 8;

/** Parameters of the height function that come from the component. */
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

export const defaultDetail: TerrainDetail = {
  seed: 1,
  amplitude: 0.35,
  wavelength: 6,
  octaves: 3,
};

// Noise -----------------------------------------------------------------------
// A line-for-line port of packages/blot/lib/noise.blot (perlin3 / fbm2), so the
// same seed gives the same ground in Blot, TypeScript and the terrain shader.

/** Lattice hash of `ink/noise`; all arithmetic wraps at 32 bits. */
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
  const u = k < 8 ? x : y;
  const v = k < 4 ? y : k === 12 || k === 14 ? x : z;
  return ((k & 1) === 0 ? u : -u) + ((k & 2) === 0 ? v : -v);
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

/** `ink/noise` `fbm2`, with an optional per-octave weight (the renderer
 * fades octaves finer than a vertex spacing; the CPU and Blot use 1). The
 * result is normalised by the full octave sum so fading never rescales. */
export function terrainNoise(
  seed: number,
  octaves: number,
  x: number,
  y: number,
  weight: (octave: number) => number = () => 1,
): number {
  let sum = 0, total = 0, amplitude = 1, frequency = 1;
  for (let octave = 0; octave < octaves; octave++) {
    sum += amplitude * weight(octave) *
      perlin3(seed + octave * 101, x * frequency, y * frequency, 0.5);
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total > 0 ? sum / total : 0;
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

// Field -----------------------------------------------------------------------

export interface TerrainRect {
  x0: number;
  z0: number;
  /** Exclusive. */
  x1: number;
  z1: number;
}

export interface TerrainHeader {
  cells: number;
  splatCells: number;
  layers: number;
  revision: number;
  overviewCells: number;
}

export const terrainPlanes = (layers: number) => Math.ceil(layers / 4);

/** Byte offsets of a file's sections. */
export function terrainLayout(h: TerrainHeader) {
  const overview = TERRAIN_HEADER_BYTES;
  const heights = overview + (h.overviewCells + 1) ** 2 * 4;
  const splat = heights + (h.cells + 1) ** 2 * 4;
  const end = splat + terrainPlanes(h.layers) * h.splatCells ** 2 * 4;
  return { overview, heights, splat, end };
}

export function readTerrainHeader(bytes: Uint8Array): TerrainHeader {
  if (bytes.byteLength < TERRAIN_HEADER_BYTES) {
    throw new Error("terrain file is truncated");
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, true) !== MAGIC) {
    throw new Error("not a terrain file (bad magic)");
  }
  if (v.getUint32(4, true) !== TERRAIN_VERSION) {
    throw new Error(`unsupported terrain version ${v.getUint32(4, true)}`);
  }
  const header = {
    cells: v.getUint32(8, true),
    splatCells: v.getUint32(12, true),
    layers: v.getUint32(16, true),
    revision: v.getUint32(20, true),
    overviewCells: v.getUint32(24, true),
  };
  if (
    header.cells < 1 || header.cells > 8192 || header.splatCells < 1 ||
    header.splatCells > 8192 || header.layers < 1 ||
    header.layers > TERRAIN_MAX_LAYERS
  ) {
    throw new Error("terrain header is out of range");
  }
  return header;
}

export function writeTerrainHeader(h: TerrainHeader): Uint8Array {
  const bytes = new Uint8Array(TERRAIN_HEADER_BYTES);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint32(4, TERRAIN_VERSION, true);
  v.setUint32(8, h.cells, true);
  v.setUint32(12, h.splatCells, true);
  v.setUint32(16, h.layers, true);
  v.setUint32(20, h.revision, true);
  v.setUint32(24, h.overviewCells, true);
  return bytes;
}

/** Cells of the overview: a power-of-two fraction of the field. */
export function overviewCellsOf(cells: number): number {
  let n = cells;
  while (n > 256 && n % 2 === 0) n /= 2;
  return n;
}

/** The editable terrain data. Heights are metres at `heightScale` 1. */
export class Heightfield {
  /** Height samples per side. */
  readonly stride: number;
  /** Bumped by every stroke; stored in the file and in the component. */
  revision = 0;

  constructor(
    readonly cells: number,
    readonly heights: Float32Array,
    readonly splatCells: number,
    readonly layers: number,
    readonly splat: Uint8Array,
  ) {
    this.stride = cells + 1;
    if (heights.length !== this.stride ** 2) {
      throw new Error("height array does not match the cell count");
    }
    if (splat.length !== terrainPlanes(layers) * splatCells ** 2 * 4) {
      throw new Error("splat array does not match the layer count");
    }
  }

  /** A flat field at `height`, fully covered by layer 0. */
  static create(
    cells: number,
    options: { splatCells?: number; layers?: number; height?: number } = {},
  ): Heightfield {
    const splatCells = options.splatCells ?? Math.max(1, cells >> 1);
    const layers = options.layers ?? 4;
    const heights = new Float32Array((cells + 1) ** 2);
    if (options.height) heights.fill(options.height);
    const splat = new Uint8Array(terrainPlanes(layers) * splatCells ** 2 * 4);
    for (let i = 0; i < splatCells ** 2; i++) splat[i * 4] = 255;
    return new Heightfield(cells, heights, splatCells, layers, splat);
  }

  static parse(source: ArrayBuffer | Uint8Array): Heightfield {
    const bytes = source instanceof Uint8Array
      ? source
      : new Uint8Array(source);
    const header = readTerrainHeader(bytes);
    const at = terrainLayout(header);
    if (bytes.byteLength < at.end) throw new Error("terrain file is truncated");
    const heights = new Float32Array((header.cells + 1) ** 2);
    new Uint8Array(heights.buffer).set(
      bytes.subarray(at.heights, at.heights + heights.byteLength),
    );
    const splat = bytes.slice(at.splat, at.end);
    const field = new Heightfield(
      header.cells,
      heights,
      header.splatCells,
      header.layers,
      splat,
    );
    field.revision = header.revision;
    return field;
  }

  /** The complete file, overview first. */
  serialize(): Uint8Array {
    const overviewCells = overviewCellsOf(this.cells);
    const header = {
      cells: this.cells,
      splatCells: this.splatCells,
      layers: this.layers,
      revision: this.revision,
      overviewCells,
    };
    const at = terrainLayout(header);
    const out = new Uint8Array(at.end);
    out.set(writeTerrainHeader(header), 0);
    out.set(
      new Uint8Array(this.overview(overviewCells).buffer),
      at.overview,
    );
    out.set(new Uint8Array(this.heights.buffer), at.heights);
    out.set(this.splat, at.splat);
    return out;
  }

  /** A box-filtered copy at `overviewCells` cells per side. */
  overview(overviewCells: number): Float32Array {
    const n = overviewCells + 1;
    const out = new Float32Array(n * n);
    const step = this.cells / overviewCells;
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        out[z * n + x] = this.sampleCell(x * step, z * step);
      }
    }
    return out;
  }

  /** Bilinear height at fractional sample coordinates (metres at scale 1). */
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

  /** Splat weight (0..1) of a layer at a fractional position of the field. */
  splatAt(layer: number, x: number, z: number): number {
    const n = this.splatCells;
    const px = Math.min(n - 1, Math.max(0, Math.floor(x / this.cells * n))),
      pz = Math.min(n - 1, Math.max(0, Math.floor(z / this.cells * n)));
    const plane = layer >> 2;
    return this.splat[plane * n * n * 4 + (pz * n + px) * 4 + (layer & 3)] /
      255;
  }
}

// World queries -----------------------------------------------------------------

/** Ground height at a terrain-local position (metres from the terrain's
 * centre), detail included. Outside the square the border value continues. */
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

/** The coarse grid game code sees: `(cells + 1)²` heights (metres, detail
 * excluded, `height_scale` applied) sampled evenly across the terrain. */
export function collisionGrid(
  field: Heightfield,
  params: TerrainParams,
  cells: number,
  rect?: TerrainRect,
  into?: Float32Array,
): Float32Array {
  const n = cells + 1;
  const out = into ?? new Float32Array(n * n);
  const ratio = field.cells / cells;
  const r = rect ?? { x0: 0, z0: 0, x1: n, z1: n };
  for (let z = Math.max(0, r.z0); z < Math.min(n, r.z1); z++) {
    for (let x = Math.max(0, r.x0); x < Math.min(n, r.x1); x++) {
      out[z * n + x] = field.sampleCell(x * ratio, z * ratio) *
        params.heightScale;
    }
  }
  return out;
}

/** The part of the collision grid a change to a field rectangle touches. */
export function collisionRect(
  rect: TerrainRect,
  fieldCells: number,
  gridCells: number,
): TerrainRect {
  const k = gridCells / fieldCells;
  return {
    x0: Math.max(0, Math.floor(rect.x0 * k) - 1),
    z0: Math.max(0, Math.floor(rect.z0 * k) - 1),
    x1: Math.min(gridCells + 1, Math.ceil(rect.x1 * k) + 2),
    z1: Math.min(gridCells + 1, Math.ceil(rect.z1 * k) + 2),
  };
}

/** Range of heights (metres at scale 1) of a node of the quadtree: the
 * renderer's culling and the tools' picking bound the ground with it. */
export function heightRange(
  field: Heightfield,
  rect: TerrainRect,
): [number, number] {
  let lo = Infinity, hi = -Infinity;
  const s = field.stride;
  const x1 = Math.min(field.stride, rect.x1),
    z1 = Math.min(field.stride, rect.z1);
  for (let z = Math.max(0, rect.z0); z < z1; z++) {
    for (let x = Math.max(0, rect.x0); x < x1; x++) {
      const v = field.heights[z * s + x];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return lo > hi ? [0, 0] : [lo, hi];
}

/** Copy of the data a rectangle of the field covers, for undo and for
 * sending an edit to the server. Heights are `(x1-x0)*(z1-z0)` floats; splat
 * is the covered texels of every plane. */
export interface TerrainPatch {
  rect: TerrainRect;
  heights: Float32Array;
  /** Splat texels of the rectangle, plane after plane. */
  splatRect: TerrainRect;
  splat: Uint8Array;
}

export function splatRectOf(
  field: Heightfield,
  rect: TerrainRect,
): TerrainRect {
  const k = field.splatCells / field.cells;
  return {
    x0: Math.max(0, Math.floor(rect.x0 * k)),
    z0: Math.max(0, Math.floor(rect.z0 * k)),
    x1: Math.min(field.splatCells, Math.ceil(rect.x1 * k) + 1),
    z1: Math.min(field.splatCells, Math.ceil(rect.z1 * k) + 1),
  };
}

export function clampRect(field: Heightfield, rect: TerrainRect): TerrainRect {
  return {
    x0: Math.max(0, Math.floor(rect.x0)),
    z0: Math.max(0, Math.floor(rect.z0)),
    x1: Math.min(field.stride, Math.ceil(rect.x1)),
    z1: Math.min(field.stride, Math.ceil(rect.z1)),
  };
}

export function readPatch(field: Heightfield, area: TerrainRect): TerrainPatch {
  const rect = clampRect(field, area);
  const w = rect.x1 - rect.x0, h = rect.z1 - rect.z0;
  const heights = new Float32Array(Math.max(0, w) * Math.max(0, h));
  for (let z = 0; z < h; z++) {
    const from = (rect.z0 + z) * field.stride + rect.x0;
    heights.set(field.heights.subarray(from, from + w), z * w);
  }
  const splatRect = splatRectOf(field, rect);
  const sw = splatRect.x1 - splatRect.x0, sh = splatRect.z1 - splatRect.z0;
  const planes = terrainPlanes(field.layers);
  const splat = new Uint8Array(Math.max(0, sw) * Math.max(0, sh) * 4 * planes);
  const n = field.splatCells;
  for (let p = 0; p < planes; p++) {
    for (let z = 0; z < sh; z++) {
      const from = p * n * n * 4 + ((splatRect.z0 + z) * n + splatRect.x0) * 4;
      splat.set(
        field.splat.subarray(from, from + sw * 4),
        (p * sh + z) * sw * 4,
      );
    }
  }
  return { rect, heights, splatRect, splat };
}

export function writePatch(field: Heightfield, patch: TerrainPatch): void {
  const { rect, splatRect } = patch;
  const w = rect.x1 - rect.x0, h = rect.z1 - rect.z0;
  for (let z = 0; z < h; z++) {
    field.heights.set(
      patch.heights.subarray(z * w, (z + 1) * w),
      (rect.z0 + z) * field.stride + rect.x0,
    );
  }
  const sw = splatRect.x1 - splatRect.x0, sh = splatRect.z1 - splatRect.z0;
  const n = field.splatCells;
  for (let p = 0; p < terrainPlanes(field.layers); p++) {
    for (let z = 0; z < sh; z++) {
      field.splat.set(
        patch.splat.subarray((p * sh + z) * sw * 4, (p * sh + z + 1) * sw * 4),
        p * n * n * 4 + ((splatRect.z0 + z) * n + splatRect.x0) * 4,
      );
    }
  }
}
