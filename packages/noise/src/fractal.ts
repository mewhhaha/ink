import { type Vec2, vec2, type Vec3, vec3 } from "@ink/math/vector.ts";
import {
  noise_period_1d,
  noise_period_2d,
  noise_period_3d,
  noise_seed,
  type NoiseInput1d,
  type NoiseInput2d,
  type NoiseInput3d,
} from "./domain.ts";
import {
  gradient_noise_1d,
  gradient_noise_2d,
  gradient_noise_3d,
} from "./gradient.ts";
import { hash_u32 } from "./hash.ts";
import { value_noise_1d, value_noise_2d, value_noise_3d } from "./value.ts";

export type FractalBasis = "value" | "gradient";

export interface FractalSettings {
  readonly octaves: number;
  readonly lacunarity: number;
  readonly gain: number;
  readonly basis?: FractalBasis;
}

export type FractalInput1d = NoiseInput1d & FractalSettings;
export type FractalInput2d = NoiseInput2d & FractalSettings;
export type FractalInput3d = NoiseInput3d & FractalSettings;

export interface DomainWarpInput2d extends FractalInput2d {
  readonly amplitude: number;
}

export interface DomainWarpInput3d extends FractalInput3d {
  readonly amplitude: number;
}

export interface CurlNoiseInput2d extends FractalInput2d {
  readonly derivative_step?: number;
}

export interface CurlNoiseInput3d extends FractalInput3d {
  readonly derivative_step?: number;
}

export function fbm_1d(input: FractalInput1d): number {
  return fractal_1d(input, "fbm");
}

export function turbulence_1d(input: FractalInput1d): number {
  return fractal_1d(input, "turbulence");
}

export function ridged_noise_1d(input: FractalInput1d): number {
  return fractal_1d(input, "ridged");
}

export function fbm_2d(input: FractalInput2d): number {
  return fractal_2d(input, "fbm");
}

export function turbulence_2d(input: FractalInput2d): number {
  return fractal_2d(input, "turbulence");
}

export function ridged_noise_2d(input: FractalInput2d): number {
  return fractal_2d(input, "ridged");
}

export function fbm_3d(input: FractalInput3d): number {
  return fractal_3d(input, "fbm");
}

export function turbulence_3d(input: FractalInput3d): number {
  return fractal_3d(input, "turbulence");
}

export function ridged_noise_3d(input: FractalInput3d): number {
  return fractal_3d(input, "ridged");
}

export function domain_warp_2d(input: DomainWarpInput2d): number {
  validate_amplitude(input.amplitude, "2D domain warp amplitude");
  const offset = vec2(
    fractal_2d({ ...input, seed: offset_seed(input.seed, 1) }, "fbm"),
    fractal_2d({ ...input, seed: offset_seed(input.seed, 2) }, "fbm"),
  );
  return fractal_2d({
    ...input,
    position: vec2(
      input.position.x + offset.x * input.amplitude,
      input.position.y + offset.y * input.amplitude,
    ),
  }, "fbm");
}

export function domain_warp_3d(input: DomainWarpInput3d): number {
  validate_amplitude(input.amplitude, "3D domain warp amplitude");
  const offset = vec3(
    fractal_3d({ ...input, seed: offset_seed(input.seed, 1) }, "fbm"),
    fractal_3d({ ...input, seed: offset_seed(input.seed, 2) }, "fbm"),
    fractal_3d({ ...input, seed: offset_seed(input.seed, 3) }, "fbm"),
  );
  return fractal_3d({
    ...input,
    position: vec3(
      input.position.x + offset.x * input.amplitude,
      input.position.y + offset.y * input.amplitude,
      input.position.z + offset.z * input.amplitude,
    ),
  }, "fbm");
}

export function curl_noise_2d(input: CurlNoiseInput2d): Vec2 {
  const step = derivative_step(input.derivative_step);
  const left = fbm_2d({
    ...input,
    position: vec2(input.position.x - step, input.position.y),
  });
  const right = fbm_2d({
    ...input,
    position: vec2(input.position.x + step, input.position.y),
  });
  const down = fbm_2d({
    ...input,
    position: vec2(input.position.x, input.position.y - step),
  });
  const up = fbm_2d({
    ...input,
    position: vec2(input.position.x, input.position.y + step),
  });
  return vec2((up - down) / (2 * step), -(right - left) / (2 * step));
}

export function curl_noise_3d(input: CurlNoiseInput3d): Vec3 {
  const step = derivative_step(input.derivative_step);
  const potential = (lane: number, position: Vec3): number =>
    fbm_3d({ ...input, seed: offset_seed(input.seed, lane), position });
  const x = input.position.x;
  const y = input.position.y;
  const z = input.position.z;
  const d_az_dy =
    (potential(3, vec3(x, y + step, z)) - potential(3, vec3(x, y - step, z))) /
    (2 * step);
  const d_ay_dz =
    (potential(2, vec3(x, y, z + step)) - potential(2, vec3(x, y, z - step))) /
    (2 * step);
  const d_ax_dz =
    (potential(1, vec3(x, y, z + step)) - potential(1, vec3(x, y, z - step))) /
    (2 * step);
  const d_az_dx =
    (potential(3, vec3(x + step, y, z)) - potential(3, vec3(x - step, y, z))) /
    (2 * step);
  const d_ay_dx =
    (potential(2, vec3(x + step, y, z)) - potential(2, vec3(x - step, y, z))) /
    (2 * step);
  const d_ax_dy =
    (potential(1, vec3(x, y + step, z)) - potential(1, vec3(x, y - step, z))) /
    (2 * step);
  return vec3(d_az_dy - d_ay_dz, d_ax_dz - d_az_dx, d_ay_dx - d_ax_dy);
}

type FractalKind = "fbm" | "turbulence" | "ridged";

function fractal_1d(input: FractalInput1d, kind: FractalKind): number {
  validate_settings(input);
  const position = periodic_coordinate(input.position, input.period?.x);
  return accumulate(input, kind, (frequency, octave_seed) => {
    const sample = {
      position: position * frequency,
      seed: octave_seed,
      period: input.period === undefined
        ? undefined
        : noise_period_1d(input.period.x * frequency),
    };
    return (input.basis ?? "gradient") === "gradient"
      ? gradient_noise_1d(sample)
      : value_noise_1d(sample);
  });
}

function fractal_2d(input: FractalInput2d, kind: FractalKind): number {
  validate_settings(input);
  const position = vec2(
    periodic_coordinate(input.position.x, input.period?.x),
    periodic_coordinate(input.position.y, input.period?.y),
  );
  return accumulate(input, kind, (frequency, octave_seed) => {
    const sample = {
      position: vec2(position.x * frequency, position.y * frequency),
      seed: octave_seed,
      period: input.period === undefined ? undefined : noise_period_2d(
        input.period.x * frequency,
        input.period.y * frequency,
      ),
    };
    return (input.basis ?? "gradient") === "gradient"
      ? gradient_noise_2d(sample)
      : value_noise_2d(sample);
  });
}

function fractal_3d(input: FractalInput3d, kind: FractalKind): number {
  validate_settings(input);
  const position = vec3(
    periodic_coordinate(input.position.x, input.period?.x),
    periodic_coordinate(input.position.y, input.period?.y),
    periodic_coordinate(input.position.z, input.period?.z),
  );
  return accumulate(input, kind, (frequency, octave_seed) => {
    const sample = {
      position: vec3(
        position.x * frequency,
        position.y * frequency,
        position.z * frequency,
      ),
      seed: octave_seed,
      period: input.period === undefined ? undefined : noise_period_3d(
        input.period.x * frequency,
        input.period.y * frequency,
        input.period.z * frequency,
      ),
    };
    return (input.basis ?? "gradient") === "gradient"
      ? gradient_noise_3d(sample)
      : value_noise_3d(sample);
  });
}

function accumulate(
  settings: FractalSettings & { readonly seed: ReturnType<typeof noise_seed> },
  kind: FractalKind,
  sample: (frequency: number, seed: ReturnType<typeof noise_seed>) => number,
): number {
  let frequency = 1;
  let amplitude = 1;
  let total = 0;
  let amplitude_sum = 0;
  for (let octave = 0; octave < settings.octaves; octave++) {
    const value = sample(frequency, offset_seed(settings.seed, octave));
    total += shaped(value, kind) * amplitude;
    amplitude_sum += amplitude;
    frequency *= settings.lacunarity;
    amplitude *= settings.gain;
  }
  return total / amplitude_sum;
}

function shaped(value: number, kind: FractalKind): number {
  if (kind === "turbulence") return Math.abs(value);
  if (kind === "ridged") return 1 - Math.abs(value);
  return value;
}

function validate_settings(settings: FractalSettings): void {
  if (
    !Number.isSafeInteger(settings.octaves) || settings.octaves <= 0 ||
    settings.octaves > 32
  ) {
    throw new Error(
      `noise octave count ${settings.octaves} must be within [1, 32]`,
    );
  }
  if (
    settings.basis !== undefined && settings.basis !== "value" &&
    settings.basis !== "gradient"
  ) {
    throw new Error(
      `noise basis ${JSON.stringify(settings.basis)} is unsupported`,
    );
  }
  if (!Number.isSafeInteger(settings.lacunarity) || settings.lacunarity <= 0) {
    throw new Error(
      `noise lacunarity ${settings.lacunarity} must be a positive integer so periodic sampling remains exact`,
    );
  }
  if (
    !Number.isFinite(settings.gain) || settings.gain <= 0 || settings.gain > 1
  ) {
    throw new Error(`noise gain ${settings.gain} must be within (0, 1]`);
  }
}

function validate_amplitude(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} ${value} must be finite and nonnegative`);
  }
}

function derivative_step(value = 0.001): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `curl derivative step ${value} must be finite and positive`,
    );
  }
  return value;
}

function offset_seed(
  seed: ReturnType<typeof noise_seed>,
  lane: number,
): ReturnType<typeof noise_seed> {
  return noise_seed(hash_u32(seed, lane, 0, 0, 0x51ed));
}

function periodic_coordinate(
  value: number,
  period: number | undefined,
): number {
  if (period === undefined) return value;
  return ((value % period) + period) % period;
}
