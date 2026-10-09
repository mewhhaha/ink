/**
 * Ray against a heightfield terrain on the CPU: what the brush cursor and the
 * tools use to find the ground under the pointer.
 *
 * The ray is walked through the leaves of the terrain's min/max tree (a
 * square of `leaf` cells; `TerrainResource.boundsOf` supplies the bounds).
 * A leaf the ray passes over or under is skipped whole; inside a leaf the ray
 * marches in half-cell steps to the first sample below the ground and
 * bisects to the surface. The ground includes the procedural detail, so the
 * hit agrees with the renderer, `terrainHeightAt` and Blot. A ray that starts
 * below the ground (a camera under the terrain) hits nothing.
 */
import {
  type Heightfield,
  heightRange,
  type Ray,
  terrainHeightAt,
  terrainNormalAt,
  type TerrainParams,
  type Vec3,
} from "@ink/geometry";

/** The most the detail noise can reach as a fraction of its amplitude. */
const NOISE_BOUND = 1.04;

export interface TerrainSurface {
  field: Heightfield;
  params: TerrainParams;
  /** World position of the terrain's centre; the ground is `origin.y` plus
   * the height at a point. */
  origin: Vec3;
  /** Min and max field heights over leaves [x0, x1) x [z0, z1); defaults to
   * scanning the field (use `TerrainResource.boundsOf`, which is cached). */
  bounds?: (
    x0: number,
    z0: number,
    x1: number,
    z1: number,
  ) => [number, number];
  /** Cells per leaf of `bounds` (default 32, `TERRAIN_LEAF`). */
  leaf?: number;
}

export interface TerrainHit {
  /** Distance along the ray. */
  distance: number;
  /** World position of the hit. */
  point: Vec3;
  /** Terrain-local metres from the middle, +x east, +z south. */
  x: number;
  z: number;
  /** Height of the ground at the hit relative to the terrain's origin,
   * detail and `height_scale` included. */
  height: number;
  /** Unit surface normal. */
  normal: Vec3;
}

export function raycastTerrain(
  ray: Ray,
  surface: TerrainSurface,
  maxDistance = Infinity,
): TerrainHit | null {
  const { field, params, origin } = surface;
  const half = params.size / 2;
  const cell = params.size / field.cells;
  const leaf = surface.leaf ?? 32;
  const leaves = Math.ceil(field.cells / leaf);
  const leafMetres = leaf * cell;
  const scale = params.heightScale;
  // A little slack keeps a perfectly flat leaf from being a zero-thickness band.
  const detailMax = params.detail.amplitude * NOISE_BOUND + 0.01;

  const ox = ray.origin[0] - origin[0],
    oy = ray.origin[1] - origin[1],
    oz = ray.origin[2] - origin[2];
  const dx = ray.direction[0], dy = ray.direction[1], dz = ray.direction[2];

  const cache = new Map<number, [number, number]>();
  const range = (i: number, j: number): [number, number] => {
    let found = cache.get(j * leaves + i);
    if (!found) {
      const [lo, hi] = surface.bounds
        ? surface.bounds(i, j, i + 1, j + 1)
        : heightRange(field, {
          x0: i * leaf,
          z0: j * leaf,
          x1: (i + 1) * leaf + 1,
          z1: (j + 1) * leaf + 1,
        });
      // Heights scale by a possibly negative factor.
      const a = lo * scale, b = hi * scale;
      found = [Math.min(a, b) - detailMax, Math.max(a, b) + detailMax];
      cache.set(j * leaves + i, found);
    }
    return found;
  };

  // Clip to the terrain's square and to its overall height range.
  let t0 = 0, t1 = maxDistance;
  const slab = (o: number, d: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < 1e-12) return o >= lo && o <= hi;
    let a = (lo - o) / d, b = (hi - o) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    return t0 <= t1;
  };
  let low = Infinity, high = -Infinity;
  for (let j = 0; j < leaves; j++) {
    for (let i = 0; i < leaves; i++) {
      const [lo, hi] = range(i, j);
      if (lo < low) low = lo;
      if (hi > high) high = hi;
    }
  }
  if (
    !slab(ox, dx, -half, half) || !slab(oz, dz, -half, half) ||
    !slab(oy, dy, low, high)
  ) return null;

  const ground = (x: number, z: number) => terrainHeightAt(field, params, x, z);
  // The ray must start above the ground to enter it.
  const above = (t: number) => oy + dy * t - ground(ox + dx * t, oz + dz * t);
  if (above(t0) <= 0) return null;

  const step = Math.min(cell * 0.5, 2);
  const finish = (a: number, b: number): TerrainHit => {
    // `a` is above the ground, `b` at or below it.
    for (let k = 0; k < 24; k++) {
      const m = (a + b) / 2;
      if (above(m) > 0) a = m;
      else b = m;
    }
    const t = (a + b) / 2;
    const x = ox + dx * t, z = oz + dz * t;
    const height = ground(x, z);
    return {
      distance: t,
      point: [origin[0] + x, origin[1] + height, origin[2] + z],
      x,
      z,
      height,
      normal: terrainNormalAt(field, params, x, z, Math.max(0.5, cell * 0.5)),
    };
  };

  // Walk the leaves the ray crosses (Amanatides and Woo).
  const px = ox + dx * t0, pz = oz + dz * t0;
  const clampLeaf = (v: number) =>
    Math.min(leaves - 1, Math.max(0, Math.floor(v)));
  let i = clampLeaf((px + half) / leafMetres);
  let j = clampLeaf((pz + half) / leafMetres);
  const stepI = dx > 0 ? 1 : -1, stepJ = dz > 0 ? 1 : -1;
  const next = (index: number, s: number, o: number, d: number) =>
    Math.abs(d) < 1e-12
      ? Infinity
      : ((index + (s > 0 ? 1 : 0)) * leafMetres - half - o) / d;
  let tx = next(i, stepI, ox, dx), tz = next(j, stepJ, oz, dz);
  const deltaX = Math.abs(dx) < 1e-12 ? Infinity : leafMetres / Math.abs(dx);
  const deltaZ = Math.abs(dz) < 1e-12 ? Infinity : leafMetres / Math.abs(dz);

  let t = t0;
  let lastAbove = t0;
  while (t < t1) {
    const exit = Math.min(tx, tz, t1);
    const [lo, hi] = range(i, j);
    const yA = oy + dy * t, yB = oy + dy * exit;
    if (Math.min(yA, yB) <= hi && Math.max(yA, yB) >= lo) {
      // The ray is inside this leaf's height band: march it.
      let s = t;
      while (s < exit) {
        const at = Math.min(exit, s + step);
        if (above(at) <= 0) return finish(Math.max(lastAbove, s), at);
        lastAbove = at;
        s = at;
        if (at >= exit) break;
      }
    } else if (yA > hi) lastAbove = exit;
    // else: under this leaf's lowest ground, which only happens after the ray
    // has already hit the surface or begun below it.
    t = exit;
    if (exit >= t1) break;
    if (tx < tz) {
      i += stepI;
      tx += deltaX;
      if (i < 0 || i >= leaves) break;
    } else {
      j += stepJ;
      tz += deltaZ;
      if (j < 0 || j >= leaves) break;
    }
  }
  return null;
}

/** The nearest hit among several terrains, with the index of the terrain. */
export function raycastTerrains(
  ray: Ray,
  surfaces: readonly TerrainSurface[],
  maxDistance = Infinity,
): { hit: TerrainHit; index: number } | null {
  let best: { hit: TerrainHit; index: number } | null = null;
  surfaces.forEach((surface, index) => {
    const hit = raycastTerrain(ray, surface, best?.hit.distance ?? maxDistance);
    if (hit && (!best || hit.distance < best.hit.distance)) {
      best = { hit, index };
    }
  });
  return best;
}
