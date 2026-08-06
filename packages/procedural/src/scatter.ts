import { finite_number } from "@ink/math/scalar.ts";
import type { Vec2 } from "@ink/math/vector.ts";
import { vec2, vec2_length_squared, vec2_subtract } from "@ink/math/vector.ts";
import {
  coordinate_random,
  type GeneratorRevision,
  type ProceduralSeed,
} from "./identity.ts";

export interface ScatterMask {
  readonly sample: (x: number, z: number) => number;
}

export interface ScatterRecipe {
  readonly seed: ProceduralSeed;
  readonly revision: GeneratorRevision;
  readonly minimum_x: number;
  readonly minimum_z: number;
  readonly maximum_x: number;
  readonly maximum_z: number;
  readonly spacing: number;
  readonly maximum_points: number;
  readonly density: ScatterMask;
}

export interface ScatterPoint {
  readonly id: string;
  readonly position: Vec2;
  readonly rotation_radians: number;
  readonly scale: number;
}

export function scatter_points(
  recipe: ScatterRecipe,
): readonly ScatterPoint[] {
  const minimum_x = finite_number(recipe.minimum_x, "scatter minimum x");
  const minimum_z = finite_number(recipe.minimum_z, "scatter minimum z");
  const maximum_x = finite_number(recipe.maximum_x, "scatter maximum x");
  const maximum_z = finite_number(recipe.maximum_z, "scatter maximum z");
  if (minimum_x >= maximum_x || minimum_z >= maximum_z) {
    throw new Error(
      `scatter bounds (${minimum_x}, ${minimum_z})..(${maximum_x}, ${maximum_z}) must have positive area`,
    );
  }
  const spacing = positive(recipe.spacing, "scatter spacing");
  const maximum_points = nonnegative_integer(
    recipe.maximum_points,
    "scatter maximum points",
  );
  const columns = Math.ceil((maximum_x - minimum_x) / spacing);
  const rows = Math.ceil((maximum_z - minimum_z) / spacing);
  const minimum_distance_squared = spacing * spacing;
  const points: ScatterPoint[] = [];
  for (let row = 0; row < rows && points.length < maximum_points; row += 1) {
    for (
      let column = 0;
      column < columns && points.length < maximum_points;
      column += 1
    ) {
      const x = minimum_x +
        (column + coordinate_random(
            recipe.seed,
            recipe.revision,
            [column, row],
            "scatter-x",
          )) * spacing;
      const z = minimum_z +
        (row + coordinate_random(
            recipe.seed,
            recipe.revision,
            [column, row],
            "scatter-z",
          )) * spacing;
      if (x >= maximum_x || z >= maximum_z) continue;
      const density = finite_number(
        recipe.density.sample(x, z),
        `scatter density (${x}, ${z})`,
      );
      if (density < 0 || density > 1) {
        throw new Error(
          `scatter density (${x}, ${z}) ${density} must be in 0..1`,
        );
      }
      if (
        coordinate_random(
          recipe.seed,
          recipe.revision,
          [column, row],
          "scatter-density",
        ) >= density
      ) continue;
      const position = vec2(x, z);
      if (
        points.some((point) =>
          vec2_length_squared(vec2_subtract(point.position, position)) <
            minimum_distance_squared
        )
      ) continue;
      const identity = `${recipe.seed}:${recipe.revision}:${column}:${row}`;
      points.push(Object.freeze({
        id: identity,
        position,
        rotation_radians: coordinate_random(
          recipe.seed,
          recipe.revision,
          [column, row],
          "scatter-rotation",
        ) * Math.PI * 2,
        scale: 0.75 + coordinate_random(
              recipe.seed,
              recipe.revision,
              [column, row],
              "scatter-scale",
            ) * 0.5,
      }));
    }
  }
  return Object.freeze(points);
}

function positive(value: number, label: string): number {
  finite_number(value, label);
  if (value <= 0) throw new Error(`${label} ${value} must be positive`);
  return value;
}

function nonnegative_integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} ${value} must be a nonnegative safe integer`);
  }
  return value;
}
