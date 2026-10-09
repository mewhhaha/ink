/**
 * Brush operations on a `Heightfield`. Pure and DOM-free.
 *
 * A dab is one application of a brush at a point: a circle of `radius` metres
 * with a falloff profile. Every operation touches only the samples inside the
 * dab's bounding rectangle (the only allocation is a scratch buffer of that
 * size), so a dab costs the same on a 2049x2049 field as on a 65x65 one.
 * `DabPath` places dabs along a drag at a fixed spacing in metres, so a stroke
 * does not depend on how often the pointer reports.
 *
 * Positions are terrain-local metres from the middle of the terrain (+x east,
 * +z south). Heights are the stored field values: metres at `height_scale` 1,
 * so divide an amount in world metres by the component's `height_scale`.
 */
import {
  type Heightfield,
  terrainNoise,
  type TerrainRect,
} from "@ink/geometry";

export type FalloffShape = "smooth" | "linear" | "sphere" | "tip" | "constant";

export const falloffShapes: readonly FalloffShape[] = [
  "smooth",
  "linear",
  "sphere",
  "tip",
  "constant",
];

export interface Falloff {
  shape: FalloffShape;
  /** 0..1: the part of the radius, from the centre, at full strength. */
  hardness: number;
}

/** A terrain's field and its side length: what the operations need. */
export interface Ground {
  field: Heightfield;
  /** Side length of the terrain in metres. */
  size: number;
}

export interface Dab {
  /** Centre, terrain-local metres. */
  x: number;
  z: number;
  /** Metres. */
  radius: number;
  falloff: Falloff;
}

/** What a dab may change: height samples and splat texels (exclusive ends). */
export interface Footprint {
  rect: TerrainRect | null;
  splatRect: TerrainRect | null;
}

const TABLE = 1024;
const tables = new Map<string, Float32Array>();

/** Strength 0..1 at normalised distance `q` (0 centre, 1 rim) from the centre. */
export function falloffWeight(falloff: Falloff, q: number): number {
  if (q >= 1) return 0;
  const hardness = Math.min(0.999, Math.max(0, falloff.hardness));
  if (q <= hardness) return 1;
  const s = (q - hardness) / (1 - hardness);
  switch (falloff.shape) {
    case "smooth":
      return 1 - s * s * (3 - 2 * s);
    case "linear":
      return 1 - s;
    case "sphere":
      return Math.sqrt(1 - s * s);
    case "tip":
      return (1 - s) * (1 - s);
    case "constant":
      return 1;
  }
}

/** The falloff sampled at `TABLE + 1` distances, shared between dabs. */
function tableFor(falloff: Falloff): Float32Array {
  const key = `${falloff.shape}:${falloff.hardness.toFixed(3)}`;
  let table = tables.get(key);
  if (!table) {
    table = new Float32Array(TABLE + 1);
    for (let i = 0; i <= TABLE; i++) {
      table[i] = falloffWeight(falloff, i / TABLE);
    }
    if (tables.size > 64) tables.clear();
    tables.set(key, table);
  }
  return table;
}

interface Region {
  rect: TerrainRect;
  /** Centre in sample coordinates, and radius in samples. */
  cx: number;
  cz: number;
  r: number;
  /** Metres per sample. */
  cell: number;
}

function regionOf(g: Ground, dab: Dab): Region | null {
  const { field } = g;
  const cell = g.size / field.cells;
  const cx = (dab.x + g.size / 2) / cell, cz = (dab.z + g.size / 2) / cell;
  const r = dab.radius / cell;
  const rect = {
    x0: Math.max(0, Math.ceil(cx - r)),
    z0: Math.max(0, Math.ceil(cz - r)),
    x1: Math.min(field.stride, Math.floor(cx + r) + 1),
    z1: Math.min(field.stride, Math.floor(cz + r) + 1),
  };
  if (rect.x1 <= rect.x0 || rect.z1 <= rect.z0 || !(r > 0)) return null;
  return { rect, cx, cz, r, cell };
}

/** Splat texels whose centres lie within the dab's bounding box. */
function splatRegion(g: Ground, dab: Dab) {
  const { field } = g;
  const n = field.splatCells;
  // Texel s covers field coordinates [s, s + 1) * cells / n.
  const texel = g.size / n;
  const cx = (dab.x + g.size / 2) / texel - 0.5;
  const cz = (dab.z + g.size / 2) / texel - 0.5;
  const r = dab.radius / texel;
  const rect = {
    x0: Math.max(0, Math.ceil(cx - r)),
    z0: Math.max(0, Math.ceil(cz - r)),
    x1: Math.min(n, Math.floor(cx + r) + 1),
    z1: Math.min(n, Math.floor(cz + r) + 1),
  };
  if (rect.x1 <= rect.x0 || rect.z1 <= rect.z0 || !(r > 0)) return null;
  return { rect, cx, cz, r, texel };
}

/** What `dab` may change, for the stroke recorder to save before applying it.
 * Height operations only touch `rect`, painting only `splatRect`. */
export function footprint(g: Ground, dab: Dab, paints = false): Footprint {
  if (paints) {
    return { rect: null, splatRect: splatRegion(g, dab)?.rect ?? null };
  }
  const region = regionOf(g, dab);
  return { rect: region?.rect ?? null, splatRect: null };
}

/** Loop over the height samples inside the dab's circle. */
function forEachSample(
  g: Ground,
  dab: Dab,
  visit: (index: number, x: number, z: number, weight: number) => void,
): TerrainRect | null {
  const region = regionOf(g, dab);
  if (!region) return null;
  const table = tableFor(dab.falloff);
  const { rect, cx, cz, r } = region;
  const r2 = r * r, scale = TABLE / r, stride = g.field.stride;
  for (let z = rect.z0; z < rect.z1; z++) {
    const dz = z - cz, dz2 = dz * dz;
    for (let x = rect.x0; x < rect.x1; x++) {
      const dx = x - cx, d2 = dx * dx + dz2;
      if (d2 >= r2) continue;
      const w = table[(Math.sqrt(d2) * scale) | 0];
      if (w > 0) visit(z * stride + x, x, z, w);
    }
  }
  return rect;
}

/** Add `metres * weight` to the heights (negative lowers). */
export function raise(g: Ground, dab: Dab, metres: number): Footprint {
  const h = g.field.heights;
  const rect = forEachSample(g, dab, (i, _x, _z, w) => {
    h[i] += metres * w;
  });
  return { rect, splatRect: null };
}

type Scratch = Float64Array<ArrayBuffer>;
let source: Scratch = new Float64Array(0);
let across: Scratch = new Float64Array(0);
let prefix: Scratch = new Float64Array(0);
const grown = (buffer: Scratch, length: number): Scratch =>
  buffer.length >= length ? buffer : new Float64Array(length * 2);

/** Move heights toward the local average (a box of `kernel` samples around
 * each, clipped to the field) by `factor * weight`. */
export function smooth(
  g: Ground,
  dab: Dab,
  factor: number,
  kernel = 2,
): Footprint {
  const region = regionOf(g, dab);
  if (!region) return { rect: null, splatRect: null };
  const { field } = g;
  const { rect } = region;
  const k = Math.max(1, Math.round(kernel));
  const stride = field.stride;
  const ex0 = Math.max(0, rect.x0 - k), ex1 = Math.min(stride, rect.x1 + k);
  const ez0 = Math.max(0, rect.z0 - k), ez1 = Math.min(stride, rect.z1 + k);
  const W = ex1 - ex0, H = ez1 - ez0, w = rect.x1 - rect.x0;
  source = grown(source, W + 1);
  across = grown(across, w * H);
  prefix = grown(prefix, (H + 1) * w);
  const heights = field.heights;
  // Average across x for the dab's columns, on every row of the expanded
  // rectangle (the originals: nothing has been written yet).
  for (let z = 0; z < H; z++) {
    const row = (ez0 + z) * stride + ex0;
    source[0] = 0;
    for (let i = 0; i < W; i++) source[i + 1] = source[i] + heights[row + i];
    for (let x = rect.x0; x < rect.x1; x++) {
      const a = Math.max(ex0, x - k) - ex0, b = Math.min(ex1 - 1, x + k) - ex0;
      across[z * w + (x - rect.x0)] = (source[b + 1] - source[a]) / (b - a + 1);
    }
  }
  // Running sums down z make the second pass O(1) per sample.
  for (let c = 0; c < w; c++) prefix[c] = 0;
  for (let z = 0; z < H; z++) {
    for (let c = 0; c < w; c++) {
      prefix[(z + 1) * w + c] = prefix[z * w + c] + across[z * w + c];
    }
  }
  const touched = forEachSample(g, dab, (i, x, z, weight) => {
    const a = Math.max(ez0, z - k) - ez0, b = Math.min(ez1 - 1, z + k) - ez0;
    const c = x - rect.x0;
    const average = (prefix[(b + 1) * w + c] - prefix[a * w + c]) / (b - a + 1);
    heights[i] += (average - heights[i]) * factor * weight;
  });
  return { rect: touched, splatRect: null };
}

/** The ground a flatten brush pulls toward: a level, or a tilted plane through
 * a point (`slopeX`, `slopeZ` are metres of height per metre of distance). */
export type FlattenTarget = number | {
  height: number;
  /** Terrain-local metres of the point the plane passes through. */
  x: number;
  z: number;
  slopeX: number;
  slopeZ: number;
};

/** Move heights toward `target` by `factor * weight`. */
export function flatten(
  g: Ground,
  dab: Dab,
  target: FlattenTarget,
  factor: number,
): Footprint {
  const h = g.field.heights;
  const cell = g.size / g.field.cells, half = g.size / 2;
  const rect = forEachSample(g, dab, (i, x, z, w) => {
    const goal = typeof target === "number"
      ? target
      : target.height + target.slopeX * (x * cell - half - target.x) +
        target.slopeZ * (z * cell - half - target.z);
    h[i] += (goal - h[i]) * factor * w;
  });
  return { rect, splatRect: null };
}

export interface NoiseBrush {
  seed: number;
  /** Wavelength of the first octave, metres. */
  scale: number;
  octaves: number;
  /** Peak height change, metres, at weight 1. */
  metres: number;
}

/** Add relief: `metres * weight * noise`, sampled in terrain-local metres so
 * dabs line up whatever their positions (the basis is `terrainNoise`, the one
 * the renderer and Blot use for the procedural detail). */
export function noiseRelief(g: Ground, dab: Dab, brush: NoiseBrush): Footprint {
  const h = g.field.heights;
  const cell = g.size / g.field.cells, half = g.size / 2;
  const f = 1 / Math.max(1e-3, brush.scale);
  const octaves = Math.max(1, Math.round(brush.octaves));
  const rect = forEachSample(g, dab, (i, x, z, w) => {
    h[i] += brush.metres * w *
      terrainNoise(
        brush.seed,
        octaves,
        (x * cell - half) * f,
        (z * cell - half) * f,
      );
  });
  return { rect, splatRect: null };
}

const weights = new Int32Array(8);

/** Raise `layer`'s share of the splat map by `strength * weight` (of 255) and
 * lower the other layers in proportion, so the weights of each texel keep
 * summing to 255. With `erase`, lower the layer and give its share to the
 * others instead. */
export function paintLayer(
  g: Ground,
  dab: Dab,
  layer: number,
  strength: number,
  erase = false,
): Footprint {
  const { field } = g;
  const region = splatRegion(g, dab);
  if (!region) return { rect: null, splatRect: null };
  const count = field.layers;
  if (layer < 0 || layer >= count) return { rect: null, splatRect: null };
  const table = tableFor(dab.falloff);
  const { rect, cx, cz, r } = region;
  const n = field.splatCells, plane = n * n * 4;
  const r2 = r * r, scale = TABLE / r;
  const splat = field.splat;
  for (let z = rect.z0; z < rect.z1; z++) {
    const dz = z - cz;
    for (let x = rect.x0; x < rect.x1; x++) {
      const dx = x - cx, d2 = dx * dx + dz * dz;
      if (d2 >= r2) continue;
      const w = table[(Math.sqrt(d2) * scale) | 0];
      const delta = Math.round(strength * w * 255);
      if (delta <= 0) continue;
      const at = (z * n + x) * 4;
      let total = 0;
      for (let l = 0; l < count; l++) {
        const v = splat[(l >> 2) * plane + at + (l & 3)];
        weights[l] = v;
        total += v;
      }
      if (total === 0) {
        weights[0] = 255;
        total = 255;
      }
      const old = weights[layer];
      const target = erase
        ? Math.max(0, old - delta)
        : Math.min(255, old + delta);
      if (target === old) continue;
      const others = total - old;
      if (others <= 0) {
        // Nothing to trade with: a lone layer can only give its share to the
        // first other layer.
        if (!erase || count < 2) continue;
        weights[layer] = target;
        weights[layer === 0 ? 1 : 0] = 255 - target;
      } else {
        // The rest scale so that everything adds up to 255 again.
        const rest = 255 - target;
        let sum = target, largest = -1;
        for (let l = 0; l < count; l++) {
          if (l === layer) continue;
          weights[l] = Math.round(weights[l] * rest / others);
          sum += weights[l];
          if (largest < 0 || weights[l] > weights[largest]) largest = l;
        }
        weights[layer] = target;
        // Rounding: put the difference on the largest other layer.
        weights[largest] = Math.max(0, weights[largest] + 255 - sum);
      }
      for (let l = 0; l < count; l++) {
        splat[(l >> 2) * plane + at + (l & 3)] = weights[l];
      }
    }
  }
  return { rect: null, splatRect: rect };
}

// Dab placement ----------------------------------------------------------------

/** Places dabs at a fixed spacing along a polyline, however the pointer's
 * moves are sampled: the same path gives the same dabs. */
export class DabPath {
  #x = 0;
  #z = 0;
  /** Distance travelled since the last dab. */
  #carry = 0;
  #started = false;

  constructor(readonly spacing: number) {
    if (!(spacing > 0)) throw new Error("spacing must be positive");
  }

  get started(): boolean {
    return this.#started;
  }

  /** Begin at a point: it receives the first dab. */
  start(x: number, z: number): [number, number][] {
    this.#x = x;
    this.#z = z;
    this.#carry = 0;
    this.#started = true;
    return [[x, z]];
  }

  /** The dabs between the last point and this one. */
  move(x: number, z: number): [number, number][] {
    if (!this.#started) return this.start(x, z);
    const out: [number, number][] = [];
    const length = Math.hypot(x - this.#x, z - this.#z);
    if (length === 0) return out;
    const dx = (x - this.#x) / length, dz = (z - this.#z) / length;
    let at = this.spacing - this.#carry;
    while (at <= length) {
      out.push([this.#x + dx * at, this.#z + dz * at]);
      at += this.spacing;
    }
    this.#carry = length - (at - this.spacing);
    this.#x = x;
    this.#z = z;
    return out;
  }
}

/** Dab spacing for a brush: a fraction of the radius, never finer than a
 * height sample (dabs closer than that change nothing a sample can show). */
export function dabSpacing(radius: number, ratio: number, cell: number) {
  return Math.max(cell, radius * Math.max(0.01, ratio));
}
