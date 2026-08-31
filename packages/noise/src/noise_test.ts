import {
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { vec2, vec3 } from "@ink/math/vector.ts";
import {
  bake_noise_texture_2d,
  bake_noise_volume_3d,
  sample_noise_1d_batch,
  sample_noise_2d_batch,
} from "./experimental/batch.ts";
import {
  cellular_noise_1d,
  cellular_noise_2d,
  cellular_noise_3d,
} from "./experimental/cellular.ts";
import {
  noise_period_1d,
  noise_period_2d,
  noise_period_3d,
  noise_seed,
} from "./domain.ts";
import {
  curl_noise_2d,
  curl_noise_3d,
  domain_warp_2d,
  domain_warp_3d,
  fbm_1d,
  fbm_2d,
  fbm_3d,
  ridged_noise_2d,
  turbulence_2d,
} from "./experimental/fractal.ts";
import {
  gradient_noise_1d,
  gradient_noise_2d,
  gradient_noise_3d,
} from "./experimental/gradient.ts";
import { hash_u32 } from "./hash.ts";
import { value_noise_1d, value_noise_2d, value_noise_3d } from "./value.ts";
import {
  noise_wgsl_modules,
  noise_wgsl_source,
  verify_wgsl_parity_fixtures,
  wgsl_parity_fixtures,
} from "./experimental/wgsl.ts";

const seed = noise_seed(0x1234_5678);

Deno.test("seeded hashing is stable and uses every coordinate", () => {
  assertEquals(hash_u32(seed, -4, 9, 12, 3), 645_877_362);
  assertNotEquals(hash_u32(seed, -4, 9, 12, 3), hash_u32(seed, -4, 9, 13, 3));
  assertNotEquals(hash_u32(seed, -4, 9, 12, 3), hash_u32(seed, -4, 9, 12, 4));
});

Deno.test("strategy terrain value-noise samples match their golden output", () => {
  const terrain_seed = noise_seed(2_253_359_092);
  assertEquals(
    [
      vec2(0, 0),
      vec2(0.42, 0),
      vec2(0.84, 0),
      vec2(0, 0.42),
      vec2(0.42, 0.42),
    ].map((position) => value_noise_2d({ position, seed: terrain_seed })),
    [
      0.08653714787214994,
      -0.1381474017151179,
      -0.530552092554482,
      -0.17150283085092438,
      -0.23773409661067374,
    ],
  );
});

Deno.test("value and gradient noise are deterministic in every dimension", () => {
  assertEquals(
    value_noise_1d({ position: -2.25, seed }),
    value_noise_1d({ position: -2.25, seed }),
  );
  assertEquals(
    value_noise_2d({ position: vec2(1.25, 7.5), seed }),
    value_noise_2d({ position: vec2(1.25, 7.5), seed }),
  );
  assertEquals(
    value_noise_3d({ position: vec3(1.25, 7.5, -4.75), seed }),
    value_noise_3d({ position: vec3(1.25, 7.5, -4.75), seed }),
  );
  assertEquals(gradient_noise_1d({ position: 3, seed }), 0);
  assertEquals(gradient_noise_2d({ position: vec2(3, -7), seed }), 0);
  assertEquals(gradient_noise_3d({ position: vec3(3, -7, 2), seed }), 0);
});

Deno.test("periodic value and gradient noise tile exactly across negative coordinates", () => {
  const period_1d = noise_period_1d(7);
  const period_2d = noise_period_2d(7, 5);
  const period_3d = noise_period_3d(7, 5, 3);
  assertEquals(
    value_noise_1d({ position: -2.375, seed, period: period_1d }),
    value_noise_1d({ position: 4.625, seed, period: period_1d }),
  );
  assertEquals(
    gradient_noise_2d({
      position: vec2(-2.375, 1.25),
      seed,
      period: period_2d,
    }),
    gradient_noise_2d({ position: vec2(4.625, 6.25), seed, period: period_2d }),
  );
  assertEquals(
    value_noise_3d({
      position: vec3(-2.375, 1.25, -0.5),
      seed,
      period: period_3d,
    }),
    value_noise_3d({
      position: vec3(4.625, 6.25, 2.5),
      seed,
      period: period_3d,
    }),
  );
});

Deno.test("cellular noise returns ordered distances and stable periodic cells", () => {
  const one = cellular_noise_1d({
    position: -0.25,
    seed,
    period: noise_period_1d(4),
  });
  assertEquals(one.nearest_distance <= one.second_distance, true);
  const two = cellular_noise_2d({
    position: vec2(-1.25, 2.5),
    seed,
    period: noise_period_2d(6, 4),
    distance: "manhattan",
  });
  const repeated = cellular_noise_2d({
    position: vec2(4.75, 6.5),
    seed,
    period: noise_period_2d(6, 4),
    distance: "manhattan",
  });
  assertEquals(two.nearest_distance, repeated.nearest_distance);
  assertEquals(two.second_distance, repeated.second_distance);
  assertEquals(two.cell_id, repeated.cell_id);
  assertEquals(
    repeated.feature_position,
    vec2(two.feature_position.x + 6, two.feature_position.y + 4),
  );
  const three = cellular_noise_3d({
    position: vec3(1.25, 2.5, 3.75),
    seed,
    distance: "chebyshev",
  });
  assertEquals(
    three.edge_distance,
    three.second_distance - three.nearest_distance,
  );
});

Deno.test("fractal families normalize output and preserve declared periods", () => {
  const input = {
    position: vec2(-0.25, 1.75),
    seed,
    period: noise_period_2d(8, 6),
    octaves: 5,
    lacunarity: 2,
    gain: 0.5,
  } as const;
  assertEquals(fbm_2d(input), fbm_2d({ ...input, position: vec2(7.75, 7.75) }));
  assertEquals(turbulence_2d(input) >= 0, true);
  assertEquals(ridged_noise_2d(input) >= 0, true);
  assertEquals(
    fbm_1d({
      position: 0.25,
      seed,
      period: noise_period_1d(5),
      octaves: 3,
      lacunarity: 2,
      gain: 0.5,
    }),
    fbm_1d({
      position: 5.25,
      seed,
      period: noise_period_1d(5),
      octaves: 3,
      lacunarity: 2,
      gain: 0.5,
    }),
  );
  assertEquals(
    fbm_3d({
      position: vec3(0.25, 0.5, 0.75),
      seed,
      period: noise_period_3d(3, 4, 5),
      octaves: 3,
      lacunarity: 2,
      gain: 0.5,
    }),
    fbm_3d({
      position: vec3(3.25, 4.5, 5.75),
      seed,
      period: noise_period_3d(3, 4, 5),
      octaves: 3,
      lacunarity: 2,
      gain: 0.5,
    }),
  );
});

Deno.test("domain warp and curl fields are deterministic and periodic", () => {
  const two = {
    position: vec2(0.25, -1.5),
    seed,
    period: noise_period_2d(5, 7),
    octaves: 3,
    lacunarity: 2,
    gain: 0.5,
    amplitude: 0.75,
  } as const;
  assertEquals(
    domain_warp_2d(two),
    domain_warp_2d({ ...two, position: vec2(5.25, 5.5) }),
  );
  const curl = curl_noise_2d(two);
  assertEquals(curl, curl_noise_2d(two));
  const three = {
    position: vec3(0.25, -1.5, 2.75),
    seed,
    octaves: 2,
    lacunarity: 2,
    gain: 0.5,
    amplitude: 0.5,
  } as const;
  assertEquals(domain_warp_3d(three), domain_warp_3d(three));
  assertEquals(curl_noise_3d(three), curl_noise_3d(three));
});

Deno.test("batch sampling and texture baking use documented row-major channel order", () => {
  assertEquals(
    sample_noise_1d_batch({
      positions: [0, 0.5, 1],
      sample: (position) => position * 2,
    }),
    new Float32Array([0, 1, 2]),
  );
  assertEquals(
    sample_noise_2d_batch({
      positions: [vec2(1, 2), vec2(3, 4)],
      sample: (position) => position.x + position.y,
    }),
    new Float32Array([3, 7]),
  );
  assertEquals(
    bake_noise_texture_2d({
      width: 2,
      height: 2,
      origin: vec2(10, 20),
      step: vec2(2, 3),
      channels: [(position) => position.x, (position) => position.y],
    }).pixels,
    new Float32Array([10, 20, 12, 20, 10, 23, 12, 23]),
  );
  assertEquals(
    bake_noise_volume_3d({
      width: 1,
      height: 1,
      depth: 2,
      origin: vec3(1, 2, 3),
      step: vec3(1, 1, 4),
      channels: [(position) => position.z],
    }).pixels,
    new Float32Array([3, 7]),
  );
});

Deno.test("WGSL modules expose stable names and parity fixtures verify headlessly", () => {
  assertEquals(noise_wgsl_modules.map((module) => module.name), [
    "hash",
    "value",
    "gradient",
    "cellular",
    "fractal",
  ]);
  assertEquals(wgsl_parity_fixtures.length, 3);
  assertEquals(noise_wgsl_source().includes("ink_value_noise_3d"), true);
  verify_wgsl_parity_fixtures();
});

Deno.test("public constructors reject malformed seeds periods and fractal settings", () => {
  assertThrows(() => noise_seed(-1), Error, "unsigned 32-bit integer");
  assertThrows(() => noise_period_2d(4, 0), Error, "noise period y 0");
  assertThrows(
    () => value_noise_1d({ position: Number.POSITIVE_INFINITY, seed }),
    Error,
    "must be finite",
  );
  assertThrows(
    () =>
      fbm_2d({
        position: vec2(0, 0),
        seed,
        octaves: 0,
        lacunarity: 2,
        gain: 0.5,
      }),
    Error,
    "octave count 0",
  );
  assertThrows(
    () =>
      fbm_2d({
        position: vec2(0, 0),
        seed,
        octaves: 2,
        lacunarity: 1.5,
        gain: 0.5,
      }),
    Error,
    "positive integer so periodic sampling remains exact",
  );
  assertThrows(
    () =>
      fbm_2d({
        position: vec2(0, 0),
        seed,
        octaves: 2,
        lacunarity: 2,
        gain: 0.5,
        basis: "simplex" as never,
      }),
    Error,
    'noise basis "simplex" is unsupported',
  );
  assertThrows(
    () =>
      sample_noise_1d_batch({
        positions: [0],
        sample: () => Number.NaN,
      }),
    Error,
    "1D noise batch sample 0 NaN must be finite",
  );
  assertThrows(
    () =>
      sample_noise_1d_batch({
        positions: [0],
        sample: () => Number.MAX_VALUE,
      }),
    Error,
    "must fit in a finite Float32 value",
  );
  assertThrows(
    () => cellular_noise_1d({ position: -0x8000_0000, seed }),
    Error,
    "needs one neighboring lattice cell",
  );
  assertThrows(
    () =>
      bake_noise_texture_2d({
        width: 1,
        height: 1,
        origin: vec2(0, 0),
        step: vec2(1, 1),
        channels: [],
      }),
    Error,
    "channel count 0 must be within [1, 4]",
  );
  assertThrows(
    () =>
      bake_noise_texture_2d({
        width: 1,
        height: 1,
        origin: vec2(0, 0),
        step: vec2(1, 1),
        channels: [undefined] as never,
      }),
    Error,
    "noise texture sampler 0 must be a function",
  );
});

Deno.test("curl field has approximately zero numerical divergence", () => {
  const step = 0.002;
  const base = {
    seed,
    octaves: 3,
    lacunarity: 2,
    gain: 0.5,
    derivative_step: step,
  } as const;
  const left = curl_noise_2d({ ...base, position: vec2(0.5 - step, 1.25) });
  const right = curl_noise_2d({ ...base, position: vec2(0.5 + step, 1.25) });
  const down = curl_noise_2d({ ...base, position: vec2(0.5, 1.25 - step) });
  const up = curl_noise_2d({ ...base, position: vec2(0.5, 1.25 + step) });
  const divergence = (right.x - left.x + up.y - down.y) / (2 * step);
  assertAlmostEquals(divergence, 0, 0.000001);
});
