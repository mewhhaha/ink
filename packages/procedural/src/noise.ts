import type { NoisePeriod2d, NoiseSeed } from "@ink/noise/domain.ts";
import { fbm_2d, type FractalBasis } from "@ink/noise/fractal.ts";
import { finite_number } from "@ink/math/scalar.ts";
import type { Vec2 } from "@ink/math/vector.ts";
import { vec2 } from "@ink/math/vector.ts";
import type { ScalarField2d } from "./heightfield.ts";

export interface FractalNoiseFieldRecipe {
  readonly seed: NoiseSeed;
  readonly frequency: number;
  readonly octaves: number;
  readonly lacunarity: number;
  readonly gain: number;
  readonly basis?: FractalBasis;
  readonly period?: NoisePeriod2d;
  readonly offset?: Vec2;
}

export function fractal_noise_field(
  recipe: FractalNoiseFieldRecipe,
): ScalarField2d {
  const frequency = finite_number(recipe.frequency, "noise field frequency");
  if (frequency <= 0) {
    throw new Error(`noise field frequency ${frequency} must be positive`);
  }
  const offset = recipe.offset ?? vec2(0, 0);
  return Object.freeze({
    sample(x: number, z: number): number {
      return fbm_2d({
        position: vec2(
          offset.x + finite_number(x, "noise field x") * frequency,
          offset.y + finite_number(z, "noise field z") * frequency,
        ),
        seed: recipe.seed,
        octaves: recipe.octaves,
        lacunarity: recipe.lacunarity,
        gain: recipe.gain,
        basis: recipe.basis,
        period: recipe.period,
      });
    },
  });
}
