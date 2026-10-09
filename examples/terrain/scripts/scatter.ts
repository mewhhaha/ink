/**
 * Placements for the four scatter layers, read off the generated heightfield
 * and splat map: pines, oaks, rocks and grass clumps, 100,000 in all. Trees
 * gather in noise-shaped forests on grass at moderate slopes, rocks on stony
 * ground, and grass in meadows with the densest around the player's start.
 * Writes assets/scatter/{pines,oaks,rocks,grass}.scatter; `y` is 0 because the
 * layers follow the terrain.
 *
 *   deno run -A examples/terrain/scripts/scatter.ts
 */
import { Heightfield, ScatterSet, type TerrainParams } from "@ink/geometry";
import {
  clamp,
  DIRT,
  fbm,
  findSpawn,
  GRASS,
  groundAt,
  layerAt,
  rng,
  ROCK,
  slopeAt,
  smoothstep,
  terrainParamsFor,
  WATER_LEVEL,
} from "./world.ts";
import { TERRAIN_URL } from "./terrain.ts";

/** Where each kind may stand: the tests check every placement against these. */
export const RULES = {
  pine: {
    minHeight: 14,
    maxHeight: 175,
    /** tan of the steepest slope. */
    maxTan: 0.62,
    minGrass: 0.45,
  },
  oak: {
    minHeight: WATER_LEVEL + 2.5,
    maxHeight: 115,
    maxTan: 0.5,
    minGrass: 0.5,
  },
  rock: { minHeight: WATER_LEVEL + 0.2 },
  grass: {
    minHeight: WATER_LEVEL + 1.5,
    maxTan: 0.55,
    minGrass: 0.55,
  },
  /** Metres around the start kept free of trees and rocks. */
  clearing: 30,
  /** Metres from the terrain's edge nothing is placed in. */
  margin: 8,
  scale: {
    pine: [0.7, 1.5],
    oak: [0.7, 1.5],
    rock: [0.4, 2.5],
    grass: [0.8, 1.6],
  },
} as const;

/** Full-size targets; `scale` shrinks all of them for small test worlds. */
export const TARGETS = { pine: 14000, oak: 8000, rock: 24000, grass: 54000 };

/** Points with a footprint, hashed on a grid so spacing checks are local. */
class Occupancy {
  private readonly n: number;
  private readonly head: Int32Array;
  private readonly next: number[] = [];
  private readonly xs: number[] = [];
  private readonly zs: number[] = [];
  private readonly rs: number[] = [];

  constructor(private readonly size: number, private readonly cell: number) {
    this.n = Math.ceil(size / cell) + 1;
    this.head = new Int32Array(this.n * this.n).fill(-1);
  }

  private index(v: number) {
    return Math.min(
      this.n - 1,
      Math.max(0, Math.floor((v + this.size / 2) / this.cell)),
    );
  }

  /** True when a footprint of `radius` at (x, z) overlaps nothing placed. */
  free(x: number, z: number, radius: number, reach: number): boolean {
    const span = Math.ceil(reach / this.cell);
    const cx = this.index(x), cz = this.index(z);
    for (
      let j = Math.max(0, cz - span);
      j <= Math.min(this.n - 1, cz + span);
      j++
    ) {
      for (
        let i = Math.max(0, cx - span);
        i <= Math.min(this.n - 1, cx + span);
        i++
      ) {
        for (let k = this.head[j * this.n + i]; k >= 0; k = this.next[k]) {
          const need = (radius + this.rs[k]) * 0.9;
          const dx = x - this.xs[k], dz = z - this.zs[k];
          if (dx * dx + dz * dz < need * need) return false;
        }
      }
    }
    return true;
  }

  add(x: number, z: number, radius: number) {
    const cell = this.index(z) * this.n + this.index(x);
    this.xs.push(x);
    this.zs.push(z);
    this.rs.push(radius);
    this.next.push(this.head[cell]);
    this.head[cell] = this.xs.length - 1;
  }
}

export interface Scattered {
  pines: ScatterSet;
  oaks: ScatterSet;
  rocks: ScatterSet;
  grass: ScatterSet;
  spawn: [number, number];
}

export interface ScatterOptions {
  /** Fraction of the full-size counts to place (small test worlds). */
  scale?: number;
}

/** Place every layer on a field. Deterministic. */
export function placeScatter(
  field: Heightfield,
  params: TerrainParams,
  options: ScatterOptions = {},
): Scattered {
  const scale = options.scale ?? 1;
  const half = params.size / 2 - RULES.margin;
  const spawn = findSpawn(field, params);
  const nearSpawn = (x: number, z: number) =>
    Math.hypot(x - spawn[0], z - spawn[1]);

  const pines = new ScatterSet(TARGETS.pine * scale);
  const oaks = new ScatterSet(TARGETS.oak * scale);
  const rocks = new ScatterSet(TARGETS.rock * scale);
  const grass = new ScatterSet(TARGETS.grass * scale);
  pines.revision =
    oaks.revision =
    rocks.revision =
    grass.revision =
      1;

  const point = (random: () => number): [number, number] => [
    (random() * 2 - 1) * half,
    (random() * 2 - 1) * half,
  ];
  const between = (range: readonly [number, number], t: number) =>
    range[0] + (range[1] - range[0]) * t;

  // Trees share one occupancy so a pine never grows through an oak. ---------
  const trees = new Occupancy(params.size, 4);
  const placeTrees = (
    set: ScatterSet,
    kind: "pine" | "oak",
    target: number,
    seed: number,
  ) => {
    const random = rng(seed);
    const rule = RULES[kind];
    const footprint = kind === "pine" ? 2.5 : 3.4;
    const salt = kind === "pine" ? 61 : 67;
    const goal = Math.round(target * scale);
    for (let attempt = 0; set.count < goal && attempt < goal * 400; attempt++) {
      const [x, z] = point(random);
      const roll = random();
      // Cheap noise tests first: forests are patches of a wide noise field.
      const forest = smoothstep(
        kind === "pine" ? 0.04 : 0.07,
        kind === "pine" ? 0.2 : 0.22,
        fbm(x / 220, z / 220, 3, salt),
      );
      if (roll > forest) continue;
      if (nearSpawn(x, z) < RULES.clearing) continue;
      const height = groundAt(field, params, x, z);
      if (height < rule.minHeight || height > rule.maxHeight) continue;
      // Pines thin out towards the lowlands, oaks towards the heights.
      const habitat = kind === "pine"
        ? smoothstep(rule.minHeight, 55, height) *
          (1 - smoothstep(145, rule.maxHeight, height))
        : 1 - smoothstep(70, rule.maxHeight, height);
      if (random() > habitat) continue;
      if (layerAt(field, params, GRASS, x, z) < rule.minGrass) continue;
      if (slopeAt(field, params, x, z) > rule.maxTan) continue;
      const size = between(RULES.scale[kind], Math.pow(random(), 1.3));
      const radius = footprint * (0.6 + 0.4 * size);
      if (!trees.free(x, z, radius, footprint * 2.5)) continue;
      trees.add(x, z, radius);
      set.add({
        x,
        y: 0,
        z,
        yaw: random() * Math.PI * 2,
        scale: size,
        tint: random(),
      });
    }
  };
  placeTrees(pines, "pine", TARGETS.pine, 4001);
  placeTrees(oaks, "oak", TARGETS.oak, 4002);

  // Rocks: stony ground first, then a scattering over the rest of the land. --
  {
    const random = rng(4003);
    const occupancy = new Occupancy(params.size, 3);
    const goal = Math.round(TARGETS.rock * scale);
    const stony = Math.round(goal * 0.6);
    for (
      let attempt = 0;
      rocks.count < goal && attempt < goal * 600;
      attempt++
    ) {
      const [x, z] = point(random);
      const phase = rocks.count < stony ? 0 : 1;
      if (nearSpawn(x, z) < RULES.clearing) continue;
      const height = groundAt(field, params, x, z);
      if (height < RULES.rock.minHeight) continue;
      const rocky = layerAt(field, params, ROCK, x, z);
      const clusters = 0.3 +
        0.7 * smoothstep(-0.1, 0.3, fbm(x / 70, z / 70, 3, 71));
      const chance = phase === 0
        ? smoothstep(0.2, 0.8, rocky)
        : (0.12 + 0.5 * layerAt(field, params, DIRT, x, z) +
          0.3 * rocky) * (slopeAt(field, params, x, z) < 0.7 ? 1 : 0);
      if (random() > chance * clusters) continue;
      const size = between(RULES.scale.rock, Math.pow(random(), 3));
      const radius = 0.9 * size;
      if (!occupancy.free(x, z, radius, 5)) continue;
      occupancy.add(x, z, radius);
      rocks.add({
        x,
        y: 0,
        z,
        yaw: random() * Math.PI * 2,
        scale: size,
        tint: random(),
      });
    }
  }

  // Grass: half in the meadow around the start, half in meadow patches. -----
  {
    const random = rng(4004);
    const occupancy = new Occupancy(params.size, 2);
    const goal = Math.round(TARGETS.grass * scale);
    const meadow = Math.round(goal * 0.45);
    const rule = RULES.grass;
    for (
      let attempt = 0;
      grass.count < goal && attempt < goal * 300;
      attempt++
    ) {
      const near = grass.count < meadow;
      let x: number, z: number;
      if (near) {
        // Dense disc around the start, thinning towards its rim.
        const angle = random() * Math.PI * 2, r = 175 * Math.sqrt(random());
        x = spawn[0] + Math.cos(angle) * r;
        z = spawn[1] + Math.sin(angle) * r;
        if (Math.abs(x) > half || Math.abs(z) > half) continue;
        if (random() < smoothstep(50, 175, r)) continue;
      } else {
        [x, z] = point(random);
        const patch = smoothstep(0.02, 0.32, fbm(x / 150, z / 150, 3, 73));
        // Under the forest canopy the grass is thin.
        const shade = smoothstep(0.1, 0.3, fbm(x / 220, z / 220, 3, 61));
        if (random() > patch * (1 - 0.6 * shade)) continue;
      }
      const height = groundAt(field, params, x, z);
      if (height < rule.minHeight) continue;
      if (layerAt(field, params, GRASS, x, z) < rule.minGrass) continue;
      if (slopeAt(field, params, x, z) > rule.maxTan) continue;
      const size = between(RULES.scale.grass, random());
      if (!occupancy.free(x, z, 0.55 * size, 2.5)) continue;
      occupancy.add(x, z, 0.55 * size);
      grass.add({
        x,
        y: 0,
        z,
        yaw: random() * Math.PI * 2,
        scale: size,
        tint: clamp(
          0.5 + 0.45 * fbm(x / 30, z / 30, 2, 79) + 0.25 * (random() - 0.5),
        ),
      });
    }
  }
  return { pines, oaks, rocks, grass, spawn };
}

export const SCATTER_FILES = {
  pines: "pines.scatter",
  oaks: "oaks.scatter",
  rocks: "rocks.scatter",
  grass: "grass.scatter",
} as const;

export async function writeScatter() {
  const started = performance.now();
  const field = Heightfield.parse(await Deno.readFile(TERRAIN_URL));
  const placed = placeScatter(field, terrainParamsFor());
  const dir = new URL("../assets/scatter/", import.meta.url);
  await Deno.mkdir(dir, { recursive: true });
  let total = 0, bytes = 0;
  for (const [key, file] of Object.entries(SCATTER_FILES)) {
    const set = placed[key as keyof typeof SCATTER_FILES];
    const data = set.serialize();
    await Deno.writeFile(new URL(file, dir), data);
    total += set.count;
    bytes += data.length;
    console.log(`  ${file}: ${set.count.toLocaleString()} placements`);
  }
  console.log(
    `scatter: ${total.toLocaleString()} placements, ${
      (bytes / 1e6).toFixed(1)
    } MB, ${((performance.now() - started) / 1000).toFixed(1)} s`,
  );
}

if (import.meta.main) await writeScatter();
