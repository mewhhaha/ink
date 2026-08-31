import { finite_number } from "@ink/math/scalar.ts";
import type { Vec2 } from "@ink/math/vector.ts";
import { vec2, vec2_length_squared, vec2_subtract } from "@ink/math/vector.ts";
import {
  coordinate_random,
  generator_revision,
  type GeneratorRevision,
  procedural_seed,
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

export function scatter_recipe(source: ScatterRecipe): ScatterRecipe {
  const seed = procedural_seed(source.seed);
  const revision = generator_revision(source.revision);
  if (revision !== source.revision) {
    throw new Error(
      `generator revision ${JSON.stringify(source.revision)} is not canonical`,
    );
  }
  const minimum_x = finite_number(source.minimum_x, "scatter minimum x");
  const minimum_z = finite_number(source.minimum_z, "scatter minimum z");
  const maximum_x = finite_number(source.maximum_x, "scatter maximum x");
  const maximum_z = finite_number(source.maximum_z, "scatter maximum z");
  if (minimum_x >= maximum_x || minimum_z >= maximum_z) {
    throw new Error(
      `scatter bounds (${minimum_x}, ${minimum_z})..(${maximum_x}, ${maximum_z}) must have positive area`,
    );
  }
  const spacing = positive(source.spacing, "scatter spacing");
  const maximum_points = nonnegative_integer(
    source.maximum_points,
    "scatter maximum points",
  );
  if (typeof source.density?.sample !== "function") {
    throw new Error("scatter density sample must be a function");
  }
  return Object.freeze({
    seed,
    revision,
    minimum_x,
    minimum_z,
    maximum_x,
    maximum_z,
    spacing,
    maximum_points,
    density: Object.freeze({ sample: source.density.sample }),
  });
}

export function scatter_points(
  source: ScatterRecipe,
): readonly ScatterPoint[] {
  const recipe = scatter_recipe(source);
  const {
    seed,
    revision,
    minimum_x,
    minimum_z,
    maximum_x,
    maximum_z,
    spacing,
    maximum_points,
  } = recipe;
  const span_x = finite_number(maximum_x - minimum_x, "scatter width");
  const span_z = finite_number(maximum_z - minimum_z, "scatter depth");
  const columns = grid_size(Math.ceil(span_x / spacing), "scatter columns");
  const rows = grid_size(Math.ceil(span_z / spacing), "scatter rows");
  const candidate_count = columns * rows;
  if (!Number.isSafeInteger(candidate_count)) {
    throw new Error(
      `scatter grid ${columns}x${rows} exceeds a safe candidate count`,
    );
  }
  const minimum_distance_squared = spacing * spacing;
  const points: ScatterPoint[] = [];
  for (let row = 0; row < rows && points.length < maximum_points; row += 1) {
    for (
      let column = 0;
      column < columns && points.length < maximum_points;
      column += 1
    ) {
      const x = finite_number(
        minimum_x +
          (column + coordinate_random(
              seed,
              revision,
              [column, row],
              "scatter-x",
            )) * spacing,
        `scatter candidate ${column},${row} x`,
      );
      const z = finite_number(
        minimum_z +
          (row + coordinate_random(
              seed,
              revision,
              [column, row],
              "scatter-z",
            )) * spacing,
        `scatter candidate ${column},${row} z`,
      );
      if (x >= maximum_x || z >= maximum_z) continue;
      let sampled_density: number;
      try {
        sampled_density = recipe.density.sample(x, z);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`scatter density (${x}, ${z}) failed: ${message}`, {
          cause: error,
        });
      }
      const density = finite_number(
        sampled_density,
        `scatter density (${x}, ${z})`,
      );
      if (density < 0 || density > 1) {
        throw new Error(
          `scatter density (${x}, ${z}) ${density} must be in 0..1`,
        );
      }
      if (
        coordinate_random(
          seed,
          revision,
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
      const identity = `${seed}:${revision}:${column}:${row}`;
      points.push(Object.freeze({
        id: identity,
        position,
        rotation_radians: coordinate_random(
          seed,
          revision,
          [column, row],
          "scatter-rotation",
        ) * Math.PI * 2,
        scale: 0.75 + coordinate_random(
              seed,
              revision,
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

function grid_size(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} ${value} must be a positive safe integer`);
  }
  return value;
}
