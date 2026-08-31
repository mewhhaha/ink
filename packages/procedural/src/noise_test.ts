import { noise_seed } from "@ink/noise/domain.ts";
import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { bake_heightfield } from "./experimental/heightfield.ts";
import { fractal_noise_field } from "./experimental/noise.ts";

Deno.test("noise fields drive reproducible procedural heightfields", () => {
  const field = fractal_noise_field({
    seed: noise_seed(29),
    frequency: 0.125,
    octaves: 4,
    lacunarity: 2,
    gain: 0.5,
  });
  const recipe = { width: 8, depth: 8, spacing: 1, field } as const;
  const first = bake_heightfield(recipe);
  const second = bake_heightfield(recipe);
  assertEquals(first.heights, second.heights);
  assertNotEquals(first.heights[0], first.heights[9]);

  const authored = {
    seed: noise_seed(29),
    frequency: 0.125,
    octaves: 2,
    lacunarity: 2,
    gain: 0.5,
  };
  const detached = fractal_noise_field(authored);
  const before = detached.sample(1, 2);
  authored.octaves = 0;
  assertEquals(detached.sample(1, 2), before);
});

Deno.test("noise fields reject nonpositive spatial frequency", () => {
  assertThrows(
    () =>
      fractal_noise_field({
        seed: noise_seed(0),
        frequency: 0,
        octaves: 1,
        lacunarity: 2,
        gain: 0.5,
      }),
    Error,
    "must be positive",
  );
  assertThrows(
    () =>
      fractal_noise_field({
        seed: noise_seed(0),
        frequency: 1,
        octaves: 0,
        lacunarity: 2,
        gain: 0.5,
      }),
    Error,
    "octave count 0",
  );
});
