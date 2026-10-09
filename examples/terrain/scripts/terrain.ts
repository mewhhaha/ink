/**
 * Writes the gate world's heightfield and splat map to
 * assets/terrain/world.terrain: 2048 cells over 2048 m (1 m spacing), 1024²
 * splat texels, four layers (grass, rock, dirt, sand).
 *
 *   deno run -A examples/terrain/scripts/terrain.ts
 */
import type { Heightfield } from "@ink/geometry";
import {
  findSpawn,
  generateHeightfield,
  LAYERS,
  terrainParamsFor,
  WATER_LEVEL,
} from "./world.ts";

export const TERRAIN_URL = new URL(
  "../assets/terrain/world.terrain",
  import.meta.url,
);

/** Height range, layer coverage and the start point, for the log and tests. */
export function describeTerrain(field: Heightfield) {
  let low = Infinity, high = -Infinity, water = 0;
  for (const h of field.heights) {
    if (h < low) low = h;
    if (h > high) high = h;
    if (h < WATER_LEVEL) water++;
  }
  const n = field.splatCells, texels = n * n;
  const coverage = LAYERS.map((_, layer) => {
    let sum = 0;
    for (let i = 0; i < texels; i++) sum += field.splat[i * 4 + layer];
    return sum / 255 / texels;
  });
  return {
    low,
    high,
    water: water / field.heights.length,
    coverage,
    spawn: findSpawn(field, terrainParamsFor()),
  };
}

export async function writeTerrain() {
  const started = performance.now();
  const field = generateHeightfield();
  const bytes = field.serialize();
  await Deno.mkdir(new URL(".", TERRAIN_URL), { recursive: true });
  await Deno.writeFile(TERRAIN_URL, bytes);
  const info = describeTerrain(field);
  console.log(
    `terrain: ${field.cells} cells (${field.stride}² samples), ${field.splatCells}² splat, ${
      (bytes.length / 1e6).toFixed(1)
    } MB, ${((performance.now() - started) / 1000).toFixed(1)} s`,
  );
  console.log(
    `  heights ${info.low.toFixed(1)}..${info.high.toFixed(1)} m, ${
      (info.water * 100).toFixed(1)
    }% under water; layers ${
      LAYERS.map((name, i) => `${name} ${(info.coverage[i] * 100).toFixed(1)}%`)
        .join(", ")
    }; start ${info.spawn.map((v) => v.toFixed(0)).join(", ")}`,
  );
}

if (import.meta.main) await writeTerrain();
