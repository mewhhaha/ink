import { vec2 } from "@ink/math/vector.ts";
import {
  bake_noise_texture_2d,
  sample_noise_2d_batch,
} from "./experimental/batch.ts";
import { cellular_noise_2d } from "./experimental/cellular.ts";
import { noise_period_2d, noise_seed } from "./domain.ts";
import { domain_warp_2d, fbm_2d } from "./experimental/fractal.ts";
import { gradient_noise_2d } from "./experimental/gradient.ts";
import { hash_u32 } from "./hash.ts";
import { value_noise_2d } from "./value.ts";
import { noise_wgsl_source } from "./experimental/wgsl.ts";

const seed = noise_seed(42);
const period = noise_period_2d(256, 256);
const grid = Array.from(
  { length: 128 * 128 },
  (_, index) => vec2((index % 128) / 8, Math.floor(index / 128) / 8),
);

Deno.bench("100,000 seeded hashes", () => {
  let checksum = 0;
  for (let index = 0; index < 100_000; index++) {
    checksum ^= hash_u32(seed, index, -index, index >> 4, 3);
  }
  if (checksum === Number.POSITIVE_INFINITY) {
    throw new Error("unreachable hash checksum");
  }
});

Deno.bench("16,384 periodic 2D value samples", () => {
  sample_noise_2d_batch({
    positions: grid,
    sample: (position) => value_noise_2d({ position, seed, period }),
  });
});

Deno.bench("16,384 periodic 2D gradient samples", () => {
  sample_noise_2d_batch({
    positions: grid,
    sample: (position) => gradient_noise_2d({ position, seed, period }),
  });
});

Deno.bench("16,384 periodic 2D cellular samples", () => {
  sample_noise_2d_batch({
    positions: grid,
    sample: (position) =>
      cellular_noise_2d({ position, seed, period }).nearest_distance,
  });
});

Deno.bench("16,384 five-octave fBm samples", () => {
  sample_noise_2d_batch({
    positions: grid,
    sample: (position) =>
      fbm_2d({ position, seed, period, octaves: 5, lacunarity: 2, gain: 0.5 }),
  });
});

Deno.bench("16,384 three-octave domain-warp samples", () => {
  sample_noise_2d_batch({
    positions: grid,
    sample: (position) =>
      domain_warp_2d({
        position,
        seed,
        period,
        octaves: 3,
        lacunarity: 2,
        gain: 0.5,
        amplitude: 0.75,
      }),
  });
});

Deno.bench("256x256 four-channel texture bake", () => {
  bake_noise_texture_2d({
    width: 256,
    height: 256,
    origin: vec2(0, 0),
    step: vec2(1 / 16, 1 / 16),
    channels: [
      (position) => value_noise_2d({ position, seed, period }),
      (position) => gradient_noise_2d({ position, seed, period }),
      (position) =>
        cellular_noise_2d({ position, seed, period }).nearest_distance,
      (position) =>
        gradient_noise_2d({
          position: vec2(position.y, position.x),
          seed,
          period,
        }),
    ],
  });
});

Deno.bench("assemble WGSL module source", () => {
  noise_wgsl_source();
});
