import { vec2 } from "@ink/math/vector.ts";
import { cellular_noise_2d } from "./cellular.ts";
import { noise_period_2d, noise_seed } from "./domain.ts";
import { gradient_noise_2d } from "./gradient.ts";
import { value_noise_2d } from "./value.ts";

export interface NoiseWgslModule {
  readonly name: "hash" | "value" | "gradient" | "cellular" | "fractal";
  readonly source: string;
}

export type WgslParityFixture =
  | {
    readonly name: string;
    readonly kind: "value_2d" | "gradient_2d";
    readonly position: readonly [number, number];
    readonly seed: number;
    readonly period: readonly [number, number];
    readonly expected: number;
    readonly tolerance: number;
  }
  | {
    readonly name: string;
    readonly kind: "cellular_2d_nearest";
    readonly position: readonly [number, number];
    readonly seed: number;
    readonly period: readonly [number, number];
    readonly expected: number;
    readonly tolerance: number;
  };

export const INK_NOISE_HASH_WGSL = `
fn ink_noise_hash(seed: u32, coordinate: vec3i, lane: i32) -> u32 {
  var value = seed;
  value ^= bitcast<u32>(coordinate.x) * 0x9e3779b1u;
  value ^= bitcast<u32>(coordinate.y) * 0x85ebca77u;
  value ^= bitcast<u32>(coordinate.z) * 0xc2b2ae3du;
  value ^= bitcast<u32>(lane) * 0x27d4eb2fu;
  value = (value ^ (value >> 16u)) * 0x7feb352du;
  value = (value ^ (value >> 15u)) * 0x846ca68bu;
  return value ^ (value >> 16u);
}
fn ink_noise_signed(seed: u32, coordinate: vec3i, lane: i32) -> f32 {
  return f32(ink_noise_hash(seed, coordinate, lane)) / 4294967296.0 * 2.0 - 1.0;
}
fn ink_noise_wrap(coordinate: i32, period: i32) -> i32 {
  if (period == 0) { return coordinate; }
  return ((coordinate % period) + period) % period;
}
fn ink_noise_fade(value: f32) -> f32 {
  return value * value * value * (value * (value * 6.0 - 15.0) + 10.0);
}`.trim();

export const INK_NOISE_VALUE_WGSL = `
fn ink_value_noise_1d(position: f32, seed: u32, period: i32) -> f32 {
  let cell = i32(floor(position));
  let amount = ink_noise_fade(fract(position));
  let left = ink_noise_signed(seed, vec3i(ink_noise_wrap(cell, period), 0, 0), 0);
  let right = ink_noise_signed(seed, vec3i(ink_noise_wrap(cell + 1, period), 0, 0), 0);
  return mix(left, right, amount);
}
fn ink_value_noise_2d(position: vec2f, seed: u32, period: vec2i) -> f32 {
  let cell = vec2i(floor(position));
  let amount = vec2f(ink_noise_fade(fract(position.x)), ink_noise_fade(fract(position.y)));
  let c00 = ink_noise_signed(seed, vec3i(ink_noise_wrap(cell.x, period.x), ink_noise_wrap(cell.y, period.y), 0), 0);
  let c10 = ink_noise_signed(seed, vec3i(ink_noise_wrap(cell.x + 1, period.x), ink_noise_wrap(cell.y, period.y), 0), 0);
  let c01 = ink_noise_signed(seed, vec3i(ink_noise_wrap(cell.x, period.x), ink_noise_wrap(cell.y + 1, period.y), 0), 0);
  let c11 = ink_noise_signed(seed, vec3i(ink_noise_wrap(cell.x + 1, period.x), ink_noise_wrap(cell.y + 1, period.y), 0), 0);
  return mix(mix(c00, c10, amount.x), mix(c01, c11, amount.x), amount.y);
}
fn ink_value_noise_3d(position: vec3f, seed: u32, period: vec3i) -> f32 {
  let cell = vec3i(floor(position));
  let amount = vec3f(ink_noise_fade(fract(position.x)), ink_noise_fade(fract(position.y)), ink_noise_fade(fract(position.z)));
  var corners: array<f32, 8>;
  for (var z = 0; z <= 1; z += 1) { for (var y = 0; y <= 1; y += 1) { for (var x = 0; x <= 1; x += 1) {
    let coordinate = vec3i(ink_noise_wrap(cell.x + x, period.x), ink_noise_wrap(cell.y + y, period.y), ink_noise_wrap(cell.z + z, period.z));
    corners[u32(x + y * 2 + z * 4)] = ink_noise_signed(seed, coordinate, 0);
  } } }
  let lower = mix(mix(corners[0], corners[1], amount.x), mix(corners[2], corners[3], amount.x), amount.y);
  let upper = mix(mix(corners[4], corners[5], amount.x), mix(corners[6], corners[7], amount.x), amount.y);
  return mix(lower, upper, amount.z);
}`.trim();

export const INK_NOISE_GRADIENT_WGSL = `
fn ink_gradient_noise_1d(position: f32, seed: u32, period: i32) -> f32 {
  let cell = i32(floor(position));
  let offset = fract(position);
  let left_hash = ink_noise_hash(seed, vec3i(ink_noise_wrap(cell, period), 0, 0), 0);
  let right_hash = ink_noise_hash(seed, vec3i(ink_noise_wrap(cell + 1, period), 0, 0), 0);
  let left = select(-offset, offset, (left_hash & 1u) == 0u);
  let right_offset = offset - 1.0;
  let right = select(-right_offset, right_offset, (right_hash & 1u) == 0u);
  return mix(left, right, ink_noise_fade(offset)) * 2.0;
}
fn ink_gradient_2d(hash: u32) -> vec2f {
  let diagonal = 0.7071067811865476;
  switch (hash & 7u) {
    case 0u: { return vec2f(1.0, 0.0); } case 1u: { return vec2f(-1.0, 0.0); }
    case 2u: { return vec2f(0.0, 1.0); } case 3u: { return vec2f(0.0, -1.0); }
    case 4u: { return vec2f(diagonal, diagonal); } case 5u: { return vec2f(-diagonal, diagonal); }
    case 6u: { return vec2f(diagonal, -diagonal); } default: { return vec2f(-diagonal, -diagonal); }
  }
}
fn ink_gradient_3d(hash: u32) -> vec3f {
  let diagonal = 0.7071067811865476;
  switch (hash % 12u) {
    case 0u: { return vec3f(diagonal, diagonal, 0.0); } case 1u: { return vec3f(-diagonal, diagonal, 0.0); }
    case 2u: { return vec3f(diagonal, -diagonal, 0.0); } case 3u: { return vec3f(-diagonal, -diagonal, 0.0); }
    case 4u: { return vec3f(diagonal, 0.0, diagonal); } case 5u: { return vec3f(-diagonal, 0.0, diagonal); }
    case 6u: { return vec3f(diagonal, 0.0, -diagonal); } case 7u: { return vec3f(-diagonal, 0.0, -diagonal); }
    case 8u: { return vec3f(0.0, diagonal, diagonal); } case 9u: { return vec3f(0.0, -diagonal, diagonal); }
    case 10u: { return vec3f(0.0, diagonal, -diagonal); } default: { return vec3f(0.0, -diagonal, -diagonal); }
  }
}
fn ink_gradient_noise_2d(position: vec2f, seed: u32, period: vec2i) -> f32 {
  let cell = vec2i(floor(position));
  let offset = fract(position);
  var dots: array<f32, 4>;
  for (var y = 0; y <= 1; y += 1) { for (var x = 0; x <= 1; x += 1) {
    let coordinate = vec3i(ink_noise_wrap(cell.x + x, period.x), ink_noise_wrap(cell.y + y, period.y), 0);
    dots[u32(x + y * 2)] = dot(ink_gradient_2d(ink_noise_hash(seed, coordinate, 0)), offset - vec2f(f32(x), f32(y)));
  } }
  return mix(mix(dots[0], dots[1], ink_noise_fade(offset.x)), mix(dots[2], dots[3], ink_noise_fade(offset.x)), ink_noise_fade(offset.y)) * 1.4142135623730951;
}
fn ink_gradient_noise_3d(position: vec3f, seed: u32, period: vec3i) -> f32 {
  let cell = vec3i(floor(position));
  let offset = fract(position);
  var dots: array<f32, 8>;
  for (var z = 0; z <= 1; z += 1) { for (var y = 0; y <= 1; y += 1) { for (var x = 0; x <= 1; x += 1) {
    let coordinate = vec3i(ink_noise_wrap(cell.x + x, period.x), ink_noise_wrap(cell.y + y, period.y), ink_noise_wrap(cell.z + z, period.z));
    dots[u32(x + y * 2 + z * 4)] = dot(ink_gradient_3d(ink_noise_hash(seed, coordinate, 0)), offset - vec3f(f32(x), f32(y), f32(z)));
  } } }
  let lower = mix(mix(dots[0], dots[1], ink_noise_fade(offset.x)), mix(dots[2], dots[3], ink_noise_fade(offset.x)), ink_noise_fade(offset.y));
  let upper = mix(mix(dots[4], dots[5], ink_noise_fade(offset.x)), mix(dots[6], dots[7], ink_noise_fade(offset.x)), ink_noise_fade(offset.y));
  return mix(lower, upper, ink_noise_fade(offset.z)) * 1.1547005383792517;
}`.trim();

export const INK_NOISE_CELLULAR_WGSL = `
fn ink_cellular_nearest_1d(position: f32, seed: u32, period: i32) -> f32 {
  let center = i32(floor(position));
  var nearest = 3.402823466e+38;
  for (var offset = -1; offset <= 1; offset += 1) {
    let cell = center + offset;
    let wrapped = ink_noise_wrap(cell, period);
    let feature = f32(cell) + f32(ink_noise_hash(seed, vec3i(wrapped, 0, 0), 1)) / 4294967296.0;
    nearest = min(nearest, abs(feature - position));
  }
  return nearest;
}
fn ink_cellular_nearest_2d(position: vec2f, seed: u32, period: vec2i) -> f32 {
  let center = vec2i(floor(position));
  var nearest = 3.402823466e+38;
  for (var y = -1; y <= 1; y += 1) { for (var x = -1; x <= 1; x += 1) {
    let cell = center + vec2i(x, y);
    let wrapped = vec2i(ink_noise_wrap(cell.x, period.x), ink_noise_wrap(cell.y, period.y));
    let feature = vec2f(cell) + vec2f(
      f32(ink_noise_hash(seed, vec3i(wrapped, 0), 1)) / 4294967296.0,
      f32(ink_noise_hash(seed, vec3i(wrapped, 0), 2)) / 4294967296.0);
    nearest = min(nearest, distance(feature, position));
  } }
  return nearest;
}
fn ink_cellular_nearest_3d(position: vec3f, seed: u32, period: vec3i) -> f32 {
  let center = vec3i(floor(position));
  var nearest = 3.402823466e+38;
  for (var z = -1; z <= 1; z += 1) { for (var y = -1; y <= 1; y += 1) { for (var x = -1; x <= 1; x += 1) {
    let cell = center + vec3i(x, y, z);
    let wrapped = vec3i(ink_noise_wrap(cell.x, period.x), ink_noise_wrap(cell.y, period.y), ink_noise_wrap(cell.z, period.z));
    let feature = vec3f(cell) + vec3f(
      f32(ink_noise_hash(seed, wrapped, 1)) / 4294967296.0,
      f32(ink_noise_hash(seed, wrapped, 2)) / 4294967296.0,
      f32(ink_noise_hash(seed, wrapped, 3)) / 4294967296.0);
    nearest = min(nearest, distance(feature, position));
  } } }
  return nearest;
}`.trim();

export const INK_NOISE_FRACTAL_WGSL = `
fn ink_fbm_gradient_1d(position: f32, seed: u32, period: i32, octaves: u32, lacunarity: i32, gain: f32) -> f32 {
  var frequency = 1;
  var amplitude = 1.0;
  var total = 0.0;
  var amplitude_sum = 0.0;
  for (var octave = 0u; octave < octaves; octave += 1u) {
    let octave_seed = ink_noise_hash(seed, vec3i(i32(octave), 0, 0), 0x51ed);
    total += ink_gradient_noise_1d(position * f32(frequency), octave_seed, period * frequency) * amplitude;
    amplitude_sum += amplitude;
    frequency *= lacunarity;
    amplitude *= gain;
  }
  return total / amplitude_sum;
}
fn ink_fbm_gradient_2d(position: vec2f, seed: u32, period: vec2i, octaves: u32, lacunarity: i32, gain: f32) -> f32 {
  var frequency = 1;
  var amplitude = 1.0;
  var total = 0.0;
  var amplitude_sum = 0.0;
  for (var octave = 0u; octave < octaves; octave += 1u) {
    let octave_seed = ink_noise_hash(seed, vec3i(i32(octave), 0, 0), 0x51ed);
    total += ink_gradient_noise_2d(position * f32(frequency), octave_seed, period * frequency) * amplitude;
    amplitude_sum += amplitude;
    frequency *= lacunarity;
    amplitude *= gain;
  }
  return total / amplitude_sum;
}
fn ink_fbm_gradient_3d(position: vec3f, seed: u32, period: vec3i, octaves: u32, lacunarity: i32, gain: f32) -> f32 {
  var frequency = 1;
  var amplitude = 1.0;
  var total = 0.0;
  var amplitude_sum = 0.0;
  for (var octave = 0u; octave < octaves; octave += 1u) {
    let octave_seed = ink_noise_hash(seed, vec3i(i32(octave), 0, 0), 0x51ed);
    total += ink_gradient_noise_3d(position * f32(frequency), octave_seed, period * frequency) * amplitude;
    amplitude_sum += amplitude;
    frequency *= lacunarity;
    amplitude *= gain;
  }
  return total / amplitude_sum;
}
fn ink_turbulence_gradient_2d(position: vec2f, seed: u32, period: vec2i, octaves: u32, lacunarity: i32, gain: f32) -> f32 {
  var frequency = 1;
  var amplitude = 1.0;
  var total = 0.0;
  var amplitude_sum = 0.0;
  for (var octave = 0u; octave < octaves; octave += 1u) {
    let octave_seed = ink_noise_hash(seed, vec3i(i32(octave), 0, 0), 0x51ed);
    total += abs(ink_gradient_noise_2d(position * f32(frequency), octave_seed, period * frequency)) * amplitude;
    amplitude_sum += amplitude;
    frequency *= lacunarity;
    amplitude *= gain;
  }
  return total / amplitude_sum;
}
fn ink_ridged_gradient_2d(position: vec2f, seed: u32, period: vec2i, octaves: u32, lacunarity: i32, gain: f32) -> f32 {
  return 1.0 - ink_turbulence_gradient_2d(position, seed, period, octaves, lacunarity, gain);
}
fn ink_domain_warp_gradient_2d(position: vec2f, seed: u32, period: vec2i, octaves: u32, lacunarity: i32, gain: f32, amplitude: f32) -> f32 {
  let seed_x = ink_noise_hash(seed, vec3i(1, 0, 0), 0x51ed);
  let seed_y = ink_noise_hash(seed, vec3i(2, 0, 0), 0x51ed);
  let offset = vec2f(
    ink_fbm_gradient_2d(position, seed_x, period, octaves, lacunarity, gain),
    ink_fbm_gradient_2d(position, seed_y, period, octaves, lacunarity, gain));
  return ink_fbm_gradient_2d(position + offset * amplitude, seed, period, octaves, lacunarity, gain);
}
fn ink_curl_gradient_2d(position: vec2f, seed: u32, period: vec2i, octaves: u32, lacunarity: i32, gain: f32, derivative_step: f32) -> vec2f {
  let left = ink_fbm_gradient_2d(position - vec2f(derivative_step, 0.0), seed, period, octaves, lacunarity, gain);
  let right = ink_fbm_gradient_2d(position + vec2f(derivative_step, 0.0), seed, period, octaves, lacunarity, gain);
  let down = ink_fbm_gradient_2d(position - vec2f(0.0, derivative_step), seed, period, octaves, lacunarity, gain);
  let up = ink_fbm_gradient_2d(position + vec2f(0.0, derivative_step), seed, period, octaves, lacunarity, gain);
  return vec2f(up - down, -(right - left)) / (2.0 * derivative_step);
}`.trim();

export const noise_wgsl_modules: readonly NoiseWgslModule[] = Object.freeze([
  { name: "hash", source: INK_NOISE_HASH_WGSL },
  { name: "value", source: INK_NOISE_VALUE_WGSL },
  { name: "gradient", source: INK_NOISE_GRADIENT_WGSL },
  { name: "cellular", source: INK_NOISE_CELLULAR_WGSL },
  { name: "fractal", source: INK_NOISE_FRACTAL_WGSL },
]);

export const wgsl_parity_fixtures: readonly WgslParityFixture[] = Object.freeze(
  [
    {
      name: "periodic value negative quadrant",
      kind: "value_2d",
      position: [-1.25, 3.5],
      seed: 17,
      period: [8, 6],
      expected: -0.23414921697576574,
      tolerance: 0.000002,
    },
    {
      name: "periodic gradient interior",
      kind: "gradient_2d",
      position: [2.125, -0.75],
      seed: 99,
      period: [7, 5],
      expected: -0.27972862758742045,
      tolerance: 0.000002,
    },
    {
      name: "periodic cellular nearest",
      kind: "cellular_2d_nearest",
      position: [4.25, 1.75],
      seed: 1234,
      period: [9, 4],
      expected: 0.5745094766109737,
      tolerance: 0.000002,
    },
  ],
);

export function noise_wgsl_source(): string {
  return noise_wgsl_modules.map((module) => module.source).join("\n\n");
}

export function verify_wgsl_parity_fixtures(): void {
  for (const fixture of wgsl_parity_fixtures) {
    const seed = noise_seed(fixture.seed);
    const period = noise_period_2d(...fixture.period);
    const position = vec2(...fixture.position);
    const actual = fixture.kind === "value_2d"
      ? value_noise_2d({ position, seed, period })
      : fixture.kind === "gradient_2d"
      ? gradient_noise_2d({ position, seed, period })
      : cellular_noise_2d({ position, seed, period }).nearest_distance;
    if (Math.abs(actual - fixture.expected) > fixture.tolerance) {
      throw new Error(
        `WGSL parity fixture ${
          JSON.stringify(fixture.name)
        } expected ${fixture.expected} but CPU contract produced ${actual}`,
      );
    }
  }
}
