import { finite_number } from "@ink/math/scalar.ts";
import type { GlobalPosition } from "@ink/world/identity.ts";
import { create_terrain, type TerrainDescriptor } from "@ink/world/terrain.ts";

export interface ScalarField2d {
  readonly sample: (x: number, z: number) => number;
}

export interface HeightfieldRecipe {
  readonly width: number;
  readonly depth: number;
  readonly spacing: number;
  readonly origin_x?: number;
  readonly origin_z?: number;
  readonly base_height?: number;
  readonly amplitude?: number;
  readonly field: ScalarField2d;
}

export interface ProceduralHeightfield {
  readonly width: number;
  readonly depth: number;
  readonly spacing: number;
  readonly origin_x: number;
  readonly origin_z: number;
  readonly heights: Float32Array;
  readonly minimum_height: number;
  readonly maximum_height: number;
}

export function bake_heightfield(
  recipe: HeightfieldRecipe,
): ProceduralHeightfield {
  const width = grid_size(recipe.width, "heightfield width");
  const depth = grid_size(recipe.depth, "heightfield depth");
  const spacing = positive(recipe.spacing, "heightfield spacing");
  const origin_x = finite_number(recipe.origin_x ?? 0, "heightfield origin x");
  const origin_z = finite_number(recipe.origin_z ?? 0, "heightfield origin z");
  const base_height = finite_number(
    recipe.base_height ?? 0,
    "heightfield base height",
  );
  const amplitude = finite_number(
    recipe.amplitude ?? 1,
    "heightfield amplitude",
  );
  const heights = new Float32Array(width * depth);
  let minimum_height = Number.POSITIVE_INFINITY;
  let maximum_height = Number.NEGATIVE_INFINITY;
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const world_x = origin_x + x * spacing;
      const world_z = origin_z + z * spacing;
      const sample = finite_number(
        recipe.field.sample(world_x, world_z),
        `heightfield sample (${world_x}, ${world_z})`,
      );
      const height = finite_number(
        base_height + sample * amplitude,
        `heightfield height (${x}, ${z})`,
      );
      heights[z * width + x] = height;
      minimum_height = Math.min(minimum_height, height);
      maximum_height = Math.max(maximum_height, height);
    }
  }
  return Object.freeze({
    width,
    depth,
    spacing,
    origin_x,
    origin_z,
    heights,
    minimum_height,
    maximum_height,
  });
}

export function heightfield_to_terrain(
  heightfield: ProceduralHeightfield,
  origin: GlobalPosition,
  surfaces?: Uint16Array,
): TerrainDescriptor {
  return create_terrain({
    origin,
    width: heightfield.width,
    depth: heightfield.depth,
    spacing: heightfield.spacing,
    heights: heightfield.heights,
    surfaces,
  });
}

function grid_size(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 2) {
    throw new Error(`${label} ${value} must be a safe integer of at least 2`);
  }
  return value;
}

function positive(value: number, label: string): number {
  finite_number(value, label);
  if (value <= 0) throw new Error(`${label} ${value} must be positive`);
  return value;
}
