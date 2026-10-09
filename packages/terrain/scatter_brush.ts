/**
 * The scatter brush: which instances a dab adds or removes. Pure and
 * deterministic.
 *
 * Candidate positions come from a jittered grid hashed from the brush seed
 * and the cell, not from a random stream: the same place always offers the
 * same instance (position, yaw, scale, tint). A dab accepts the candidates
 * inside its circle (more of them near the centre) that are not too close to
 * an existing instance, so painting the same spot twice adds nothing, the
 * density does not depend on how fast the pointer moved, and a seed gives a
 * different but equally reproducible forest.
 *
 * Positions are in the scatter entity's frame (metres from its origin).
 */
import {
  noiseHash3,
  type Placement,
  SCATTER_FLOATS,
  type ScatterSet,
} from "@ink/geometry";
import { type Falloff, falloffWeight } from "./sculpt.ts";

export interface ScatterBrush {
  seed: number;
  /** Instances per square metre. */
  density: number;
  /** No two instances closer than this, metres. */
  minSpacing: number;
  /** Uniform scale range. */
  scale: [number, number];
  /** Tint range, 0..1. */
  tint: [number, number];
}

/** The most candidates one dab considers (a huge brush at high density). */
export const MAX_CANDIDATES = 20000;

const unit = (h: number) => h / 4294967296;

/** The instances a dab at (`x`, `z`) offers, before spacing and terrain. */
export function scatterCandidates(
  brush: ScatterBrush,
  x: number,
  z: number,
  radius: number,
  falloff: Falloff,
): Placement[] {
  const out: Placement[] = [];
  if (!(brush.density > 0) || !(radius > 0)) return out;
  const cell = 1 / Math.sqrt(brush.density);
  const i0 = Math.floor((x - radius) / cell) - 1;
  const i1 = Math.ceil((x + radius) / cell) + 1;
  const j0 = Math.floor((z - radius) / cell) - 1;
  const j1 = Math.ceil((z + radius) / cell) + 1;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const h = noiseHash3(i, j, 1, brush.seed);
      const px = (i + (h & 0xffff) / 65536) * cell;
      const pz = (j + (h >>> 16) / 65536) * cell;
      const d = Math.hypot(px - x, pz - z);
      if (d >= radius) continue;
      // Thin toward the rim: a candidate shows up where its own number is
      // below the brush weight.
      if (
        unit(noiseHash3(i, j, 2, brush.seed)) >=
          falloffWeight(falloff, d / radius)
      ) {
        continue;
      }
      const pick = (channel: number, range: [number, number]) =>
        range[0] +
        (range[1] - range[0]) * unit(noiseHash3(i, j, channel, brush.seed));
      out.push({
        x: px,
        y: 0,
        z: pz,
        yaw: unit(noiseHash3(i, j, 3, brush.seed)) * Math.PI * 2,
        scale: pick(4, brush.scale),
        tint: Math.min(1, Math.max(0, pick(5, brush.tint))),
      });
      if (out.length >= MAX_CANDIDATES) return out;
    }
  }
  return out;
}

/** The candidates that fit among what is already there (and each other),
 * after `place` has set their height or turned them down. */
export function planAdd(
  set: ScatterSet,
  candidates: readonly Placement[],
  minSpacing: number,
  place: (p: Placement) => Placement | null = (p) => p,
): Placement[] {
  if (!candidates.length) return [];
  // Even with no spacing, an instance exactly where one already stands is a
  // duplicate.
  const gap = Math.max(minSpacing, 0.05);
  const grid = new Map<number, number[]>();
  const key = (cx: number, cz: number) => cx * 73856093 ^ cz * 19349663;
  const insert = (x: number, z: number) => {
    const k = key(Math.floor(x / gap), Math.floor(z / gap));
    const list = grid.get(k);
    if (list) list.push(x, z);
    else grid.set(k, [x, z]);
  };
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const c of candidates) {
    x0 = Math.min(x0, c.x);
    x1 = Math.max(x1, c.x);
    z0 = Math.min(z0, c.z);
    z1 = Math.max(z1, c.z);
  }
  // One pass over the set picks out the neighbours of the dab.
  const data = set.data;
  for (let o = 0; o < set.count * SCATTER_FLOATS; o += SCATTER_FLOATS) {
    const x = data[o], z = data[o + 2];
    if (x >= x0 - gap && x <= x1 + gap && z >= z0 - gap && z <= z1 + gap) {
      insert(x, z);
    }
  }
  const near = (x: number, z: number) => {
    const cx = Math.floor(x / gap), cz = Math.floor(z / gap);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = grid.get(key(cx + dx, cz + dz));
        if (!list) continue;
        for (let i = 0; i < list.length; i += 2) {
          if (Math.hypot(list[i] - x, list[i + 1] - z) < gap) return true;
        }
      }
    }
    return false;
  };
  const added: Placement[] = [];
  for (const candidate of candidates) {
    if (near(candidate.x, candidate.z)) continue;
    const placed = place(candidate);
    if (!placed) continue;
    insert(placed.x, placed.z);
    added.push(placed);
  }
  return added;
}

/** The instances a dab removes: those in its circle, thinning toward the rim. */
export function planErase(
  set: ScatterSet,
  x: number,
  z: number,
  radius: number,
  falloff: Falloff,
  seed: number,
): Placement[] {
  const out: Placement[] = [];
  const data = set.data, r2 = radius * radius;
  for (let o = 0, i = 0; i < set.count; i++, o += SCATTER_FLOATS) {
    const dx = data[o] - x, dz = data[o + 2] - z, d2 = dx * dx + dz * dz;
    if (d2 >= r2) continue;
    const w = falloffWeight(falloff, Math.sqrt(d2) / radius);
    const h = noiseHash3(
      Math.round(data[o] * 64),
      Math.round(data[o + 2] * 64),
      7,
      seed,
    );
    if (unit(h) < w) out.push(set.get(i));
  }
  return out;
}
