import type { GlobalPosition } from "@ink/world/identity.ts";
import type { TerrainDescriptor } from "@ink/world/terrain.ts";
import {
  bake_biome_surfaces,
  type BiomeDefinition,
  type BiomeSample,
} from "./biome.ts";
import {
  bake_heightfield,
  heightfield_to_terrain,
  type HeightfieldRecipe,
  type ProceduralHeightfield,
  type ScalarField2d,
} from "./heightfield.ts";
import type { GeneratorRevision, ProceduralSeed } from "./identity.ts";
import {
  scatter_points,
  type ScatterMask,
  type ScatterPoint,
} from "./scatter.ts";

export interface ProceduralWorldRecipe {
  readonly seed: ProceduralSeed;
  readonly revision: GeneratorRevision;
  readonly origin: GlobalPosition;
  readonly heightfield: HeightfieldRecipe;
  readonly moisture: ScalarField2d;
  readonly temperature: ScalarField2d;
  readonly biomes: readonly BiomeDefinition[];
  readonly scatter_spacing: number;
  readonly scatter_limit: number;
  readonly scatter_density: ScatterMask;
}

export interface ProceduralWorldResult {
  readonly heightfield: ProceduralHeightfield;
  readonly terrain: TerrainDescriptor;
  readonly biome_surfaces: Uint16Array;
  readonly scatter: readonly ScatterPoint[];
}

export function generate_procedural_world(
  recipe: ProceduralWorldRecipe,
): ProceduralWorldResult {
  const heightfield = bake_heightfield(recipe.heightfield);
  const biome_samples: BiomeSample[] = [];
  for (let z = 0; z < heightfield.depth; z += 1) {
    for (let x = 0; x < heightfield.width; x += 1) {
      const world_x = heightfield.origin_x + x * heightfield.spacing;
      const world_z = heightfield.origin_z + z * heightfield.spacing;
      biome_samples.push(Object.freeze({
        elevation: heightfield.heights[z * heightfield.width + x],
        moisture: recipe.moisture.sample(world_x, world_z),
        temperature: recipe.temperature.sample(world_x, world_z),
      }));
    }
  }
  const biome_surfaces = bake_biome_surfaces(recipe.biomes, biome_samples);
  const terrain = heightfield_to_terrain(
    heightfield,
    recipe.origin,
    biome_surfaces,
  );
  const scatter = scatter_points({
    seed: recipe.seed,
    revision: recipe.revision,
    minimum_x: heightfield.origin_x,
    minimum_z: heightfield.origin_z,
    maximum_x: heightfield.origin_x +
      (heightfield.width - 1) * heightfield.spacing,
    maximum_z: heightfield.origin_z +
      (heightfield.depth - 1) * heightfield.spacing,
    spacing: recipe.scatter_spacing,
    maximum_points: recipe.scatter_limit,
    density: recipe.scatter_density,
  });
  return Object.freeze({
    heightfield,
    terrain,
    biome_surfaces,
    scatter,
  });
}
