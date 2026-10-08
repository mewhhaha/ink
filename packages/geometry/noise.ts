/**
 * Procedural noise: value, gradient (Perlin), simplex and cellular (Worley)
 * noise, fractal sums, and blue noise. Every 2D function can tile with a
 * period, so textures made from them wrap seamlessly. Deterministic for a
 * given seed; no global state.
 */

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/** A 32-bit integer hash of two lattice coordinates and a seed. */
export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^
    Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function hash3(x: number, y: number, z: number, seed = 0): number {
  return hash2(hash2(x, y, seed), z, seed);
}

/** Hash to [0, 1). */
const unit = (h: number) => h / 4294967296;

const wrap = (i: number, period: number) =>
  period > 0 ? ((i % period) + period) % period : i;

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export interface NoiseOptions {
  seed?: number;
  /** Lattice period for tiling; 0 does not tile. */
  period?: number;
}

/** Value noise in [-1, 1]. */
export function value2(
  x: number,
  y: number,
  options: NoiseOptions = {},
): number {
  const { seed = 0, period = 0 } = options;
  const xi = Math.floor(x), yi = Math.floor(y);
  const u = fade(x - xi), v = fade(y - yi);
  const h = (i: number, j: number) =>
    unit(hash2(wrap(xi + i, period), wrap(yi + j, period), seed)) * 2 - 1;
  return lerp(lerp(h(0, 0), h(1, 0), u), lerp(h(0, 1), h(1, 1), u), v);
}

function gradient2(h: number, x: number, y: number): number {
  // Eight unit-ish directions.
  switch (h & 7) {
    case 0:
      return x + y;
    case 1:
      return -x + y;
    case 2:
      return x - y;
    case 3:
      return -x - y;
    case 4:
      return x * 1.4142;
    case 5:
      return -x * 1.4142;
    case 6:
      return y * 1.4142;
    default:
      return -y * 1.4142;
  }
}

/** Gradient (Perlin) noise, roughly in [-1, 1]. */
export function perlin2(
  x: number,
  y: number,
  options: NoiseOptions = {},
): number {
  const { seed = 0, period = 0 } = options;
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const g = (i: number, j: number) =>
    gradient2(
      hash2(wrap(xi + i, period), wrap(yi + j, period), seed),
      xf - i,
      yf - j,
    );
  const u = fade(xf), v = fade(yf);
  return lerp(lerp(g(0, 0), g(1, 0), u), lerp(g(0, 1), g(1, 1), u), v) * 0.7071;
}

function gradient3(h: number, x: number, y: number, z: number): number {
  const k = h % 12;
  const u = k < 8 ? x : y;
  const v = k < 4 ? y : k === 12 || k === 14 ? x : z;
  return ((k & 1) ? -u : u) + ((k & 2) ? -v : v);
}

/** 3D gradient noise, roughly in [-1, 1]. Not periodic. */
export function perlin3(x: number, y: number, z: number, seed = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const g = (i: number, j: number, k: number) =>
    gradient3(hash3(xi + i, yi + j, zi + k, seed), xf - i, yf - j, zf - k);
  const u = fade(xf), v = fade(yf), w = fade(zf);
  return lerp(
    lerp(lerp(g(0, 0, 0), g(1, 0, 0), u), lerp(g(0, 1, 0), g(1, 1, 0), u), v),
    lerp(lerp(g(0, 0, 1), g(1, 0, 1), u), lerp(g(0, 1, 1), g(1, 1, 1), u), v),
    w,
  );
}

/** 2D simplex noise in [-1, 1]. Tiling is approximate (period on the skewed
 * lattice), so use perlin2 for exactly seamless textures. */
export function simplex2(
  x: number,
  y: number,
  options: NoiseOptions = {},
): number {
  const { seed = 0, period = 0 } = options;
  const s = (x + y) * F2;
  const i = Math.floor(x + s), j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t), y0 = y - (j - t);
  const [i1, j1] = x0 > y0 ? [1, 0] : [0, 1];
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
  const corner = (cx: number, cy: number, gi: number, gj: number) => {
    const r = 0.5 - cx * cx - cy * cy;
    if (r <= 0) return 0;
    const h = hash2(wrap(i + gi, period), wrap(j + gj, period), seed);
    return r * r * r * r * gradient2(h, cx, cy);
  };
  return 70 *
    (corner(x0, y0, 0, 0) + corner(x1, y1, i1, j1) + corner(x2, y2, 1, 1)) /
    1.4142;
}

/** Cellular noise: distance to the nearest (`f1`) and second nearest (`f2`)
 * jittered feature point, in cell units. */
export function worley2(
  x: number,
  y: number,
  options: NoiseOptions & { jitter?: number } = {},
): { f1: number; f2: number } {
  const { seed = 0, period = 0, jitter = 1 } = options;
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = Infinity, f2 = Infinity;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const h = hash2(wrap(cx, period), wrap(cy, period), seed);
      const px = cx + 0.5 + (unit(h) - 0.5) * jitter;
      const py = cy + 0.5 + (unit(hash2(h, 7, seed)) - 0.5) * jitter;
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) f2 = d;
    }
  }
  return { f1, f2 };
}

export interface FractalOptions extends NoiseOptions {
  octaves?: number;
  lacunarity?: number;
  gain?: number;
}

/** Fractal Brownian motion: octaves of `noise`, each finer and fainter.
 * Periods double with the frequency so the sum still tiles. Result roughly
 * in [-1, 1]. */
export function fbm2(
  noise: (x: number, y: number, options: NoiseOptions) => number,
  x: number,
  y: number,
  options: FractalOptions = {},
): number {
  const { octaves = 5, lacunarity = 2, gain = 0.5, seed = 0, period = 0 } =
    options;
  let sum = 0, amplitude = 1, frequency = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amplitude *
      noise(x * frequency, y * frequency, {
        seed: seed + o * 101,
        period: period * frequency,
      });
    total += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / total;
}

/** Ridged multifractal: sharp creases, good for rock and mountains. In [0, 1]. */
export function ridged2(
  x: number,
  y: number,
  options: FractalOptions = {},
): number {
  const { octaves = 5, lacunarity = 2, gain = 0.5, seed = 0, period = 0 } =
    options;
  let sum = 0, amplitude = 1, frequency = 1, total = 0, weight = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 -
      Math.abs(
        perlin2(x * frequency, y * frequency, {
          seed: seed + o * 101,
          period: period * frequency,
        }),
      );
    n *= n * weight;
    weight = Math.min(1, n * 2);
    sum += n * amplitude;
    total += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / total;
}

/** Warp the domain by another noise before sampling: swirly, organic. */
export function warp2(
  noise: (x: number, y: number) => number,
  x: number,
  y: number,
  strength = 1,
  options: NoiseOptions = {},
): number {
  const { seed = 0, period = 0 } = options;
  const dx = fbm2(perlin2, x + 5.2, y + 1.3, {
    seed: seed + 17,
    period,
    octaves: 3,
  });
  const dy = fbm2(perlin2, x + 9.7, y + 2.8, {
    seed: seed + 31,
    period,
    octaves: 3,
  });
  return noise(x + strength * dx, y + strength * dy);
}

/**
 * Blue noise by void-and-cluster (Ulichney): a threshold map whose values
 * are spread evenly with no low-frequency clumps. Returns `size × size`
 * ranks in [0, 1). Tiles seamlessly. 64 is plenty for dithering and
 * per-pixel rotations; cost grows with size⁴.
 */
export function blueNoise(size = 64, seed = 1): Float32Array {
  const n = size * size;
  const sigma = 1.9;
  // Toroidal Gaussian kernel.
  const kernel = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.min(x, size - x), dy = Math.min(y, size - y);
      kernel[y * size + x] = Math.exp(
        -(dx * dx + dy * dy) / (2 * sigma * sigma),
      );
    }
  }
  const energy = new Float32Array(n);
  const on = new Uint8Array(n);
  // The Gaussian is negligible beyond ~5 sigma, so a splat only touches a
  // window around the point (almost the whole tile when it is small).
  const reach = Math.min((size - 1) >> 1, Math.ceil(sigma * 5));
  const splat = (index: number, sign: number) => {
    const ox = index % size, oy = (index / size) | 0;
    for (let dy = -reach; dy <= reach; dy++) {
      const y = (oy + dy + size) % size;
      const ky = ((dy + size) % size) * size;
      const row = y * size;
      for (let dx = -reach; dx <= reach; dx++) {
        energy[row + ((ox + dx + size) % size)] += sign *
          kernel[ky + ((dx + size) % size)];
      }
    }
  };
  const tightest = () => {
    let best = -1, value = -Infinity;
    for (let i = 0; i < n; i++) {
      if (on[i] && energy[i] > value) value = energy[best = i];
    }
    return best;
  };
  const largestVoid = () => {
    let best = -1, value = Infinity;
    for (let i = 0; i < n; i++) {
      if (!on[i] && energy[i] < value) value = energy[best = i];
    }
    return best;
  };
  // Initial binary pattern: ~10% random points, then relax.
  const initial = Math.max(1, Math.floor(n / 10));
  let placed = 0;
  for (let k = 0; placed < initial; k++) {
    const i = hash2(k, seed) % n;
    if (!on[i]) {
      on[i] = 1;
      splat(i, 1);
      placed++;
    }
  }
  for (;;) {
    const cluster = tightest();
    on[cluster] = 0;
    splat(cluster, -1);
    const hole = largestVoid();
    if (hole === cluster) {
      on[cluster] = 1;
      splat(cluster, 1);
      break;
    }
    on[hole] = 1;
    splat(hole, 1);
  }
  const rank = new Int32Array(n).fill(-1);
  const prototype = on.slice();
  const saved = energy.slice();
  // Phase 1: remove points from the prototype, ranking downward.
  for (let r = placed - 1; r >= 0; r--) {
    const cluster = tightest();
    on[cluster] = 0;
    splat(cluster, -1);
    rank[cluster] = r;
  }
  // Phase 2 and 3: restore and fill voids, ranking upward.
  on.set(prototype);
  energy.set(saved);
  for (let r = placed; r < n; r++) {
    const hole = largestVoid();
    on[hole] = 1;
    splat(hole, 1);
    rank[hole] = r;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rank[i] / n;
  return out;
}

export interface Image {
  width: number;
  height: number;
  /** RGBA8, sRGB. */
  data: Uint8Array;
}

/** A grey-scale image from a function of the tile coordinate in [0, 1). */
export function greyImage(
  size: number,
  fn: (u: number, v: number) => number,
): Image {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const g = Math.round(
        Math.min(1, Math.max(0, fn(x / size, y / size))) * 255,
      );
      const o = (y * size + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = g;
      data[o + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

/** Make any 2D noise tile over [0, 1)² by blending it with its own copies
 * one period away, rescaled so the blend keeps its contrast. */
export function seamless(
  noise: (x: number, y: number, options: NoiseOptions) => number,
  u: number,
  v: number,
  period: number,
  options: NoiseOptions = {},
): number {
  const x = u * period, y = v * period;
  const w = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
  const sum = w[0] * noise(x, y, options) +
    w[1] * noise(x - period, y, options) +
    w[2] * noise(x, y - period, options) +
    w[3] * noise(x - period, y - period, options);
  return sum / Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2] + w[3] * w[3]);
}

/** The renderer's `builtin:` textures. All tile seamlessly. */
export function builtinTexture(path: string): Image | undefined {
  const size = 256;
  const cells = 8;
  switch (path) {
    case "builtin:checker":
      return greyImage(
        size,
        (
          u,
          v,
        ) => ((Math.floor(u * cells) + Math.floor(v * cells)) % 2
          ? 0.55
          : 0.85),
      );
    case "builtin:grid": {
      const line = 2 / size;
      return greyImage(size, (u, v) => {
        const fu = (u * cells) % 1, fv = (v * cells) % 1;
        const edge = Math.min(fu, 1 - fu, fv, 1 - fv) * cells;
        const major = Math.min(u, 1 - u, v, 1 - v);
        return major < line ? 0.35 : edge < line * cells ? 0.5 : 0.78;
      });
    }
    case "builtin:noise/value":
      return greyImage(
        size,
        (u, v) =>
          0.5 +
          0.5 *
            fbm2(value2, u * cells, v * cells, { period: cells, octaves: 4 }),
      );
    case "builtin:noise/perlin":
      return greyImage(
        size,
        (u, v) => 0.5 + 0.5 * perlin2(u * cells, v * cells, { period: cells }),
      );
    case "builtin:noise/simplex":
      return greyImage(
        size,
        (u, v) => 0.5 + 0.5 * seamless(simplex2, u, v, cells),
      );
    case "builtin:noise/worley":
      return greyImage(
        size,
        (u, v) =>
          Math.min(1, worley2(u * cells, v * cells, { period: cells }).f1),
      );
    case "builtin:noise/fbm":
      return greyImage(
        size,
        (u, v) =>
          0.5 + 0.6 * fbm2(perlin2, u * 4, v * 4, { period: 4, octaves: 6 }),
      );
    case "builtin:noise/ridged":
      return greyImage(
        size,
        (u, v) => ridged2(u * 4, v * 4, { period: 4, octaves: 6 }),
      );
    case "builtin:noise/blue": {
      const tile = 64;
      const ranks = blueNoise(tile);
      return greyImage(
        tile,
        (u, v) => ranks[Math.floor(v * tile) * tile + Math.floor(u * tile)],
      );
    }
  }
  return undefined;
}
