import { type Vec2, vec2, type Vec3, vec3 } from "@ink/math/vector.ts";

export type NoiseSampler1d = (position: number) => number;
export type NoiseSampler2d = (position: Vec2) => number;
export type NoiseSampler3d = (position: Vec3) => number;

export interface NoiseBatch1d {
  readonly positions: readonly number[];
  readonly sample: NoiseSampler1d;
}

export interface NoiseBatch2d {
  readonly positions: readonly Vec2[];
  readonly sample: NoiseSampler2d;
}

export interface NoiseBatch3d {
  readonly positions: readonly Vec3[];
  readonly sample: NoiseSampler3d;
}

export interface NoiseTextureBake2d {
  readonly width: number;
  readonly height: number;
  readonly origin: Vec2;
  readonly step: Vec2;
  readonly channels: readonly NoiseSampler2d[];
}

export interface NoiseVolumeBake3d {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly origin: Vec3;
  readonly step: Vec3;
  readonly channels: readonly NoiseSampler3d[];
}

export interface BakedNoisePixels {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly pixels: Float32Array;
}

export interface BakedNoiseVoxels extends BakedNoisePixels {
  readonly depth: number;
}

export function sample_noise_1d_batch(input: NoiseBatch1d): Float32Array {
  return sample_batch(input.positions, input.sample, "1D noise batch");
}

export function sample_noise_2d_batch(input: NoiseBatch2d): Float32Array {
  return sample_batch(input.positions, input.sample, "2D noise batch");
}

export function sample_noise_3d_batch(input: NoiseBatch3d): Float32Array {
  return sample_batch(input.positions, input.sample, "3D noise batch");
}

export function bake_noise_texture_2d(
  input: NoiseTextureBake2d,
): BakedNoisePixels {
  const width = positive_size(input.width, "noise texture width");
  const height = positive_size(input.height, "noise texture height");
  const channels = channel_count(input.channels.length);
  validate_samplers(input.channels, "noise texture");
  const pixels = allocate_samples(width * height * channels, "noise texture");
  let output = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const position = vec2(
        input.origin.x + input.step.x * x,
        input.origin.y + input.step.y * y,
      );
      for (const sample of input.channels) {
        pixels[output++] = finite_sample(
          sample(position),
          "noise texture sample",
        );
      }
    }
  }
  return Object.freeze({ width, height, channels, pixels });
}

export function bake_noise_volume_3d(
  input: NoiseVolumeBake3d,
): BakedNoiseVoxels {
  const width = positive_size(input.width, "noise volume width");
  const height = positive_size(input.height, "noise volume height");
  const depth = positive_size(input.depth, "noise volume depth");
  const channels = channel_count(input.channels.length);
  validate_samplers(input.channels, "noise volume");
  const voxels = allocate_samples(
    width * height * depth * channels,
    "noise volume",
  );
  let output = 0;
  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const position = vec3(
          input.origin.x + input.step.x * x,
          input.origin.y + input.step.y * y,
          input.origin.z + input.step.z * z,
        );
        for (const sample of input.channels) {
          voxels[output++] = finite_sample(
            sample(position),
            "noise volume sample",
          );
        }
      }
    }
  }
  return Object.freeze({ width, height, depth, channels, pixels: voxels });
}

function sample_batch<Position>(
  positions: readonly Position[],
  sample: (position: Position) => number,
  label: string,
): Float32Array {
  validate_samplers([sample], label);
  const output = allocate_samples(positions.length, label);
  for (const [index, position] of positions.entries()) {
    output[index] = finite_sample(sample(position), `${label} sample ${index}`);
  }
  return output;
}

function validate_samplers(
  samplers: readonly unknown[],
  label: string,
): void {
  const invalid = samplers.findIndex((sample) => typeof sample !== "function");
  if (invalid >= 0) {
    throw new Error(`${label} sampler ${invalid} must be a function`);
  }
}

function positive_size(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} ${value} must be a positive safe integer`);
  }
  return value;
}

function channel_count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4) {
    throw new Error(`noise bake channel count ${value} must be within [1, 4]`);
  }
  return value;
}

function allocate_samples(length: number, label: string): Float32Array {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0x3fff_ffff) {
    throw new Error(`${label} requires invalid sample count ${length}`);
  }
  return new Float32Array(length);
}

function finite_sample(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} ${value} must be finite`);
  }
  if (Math.abs(value) > 3.4028234663852886e38) {
    throw new Error(`${label} ${value} must fit in a finite Float32 value`);
  }
  return value;
}
