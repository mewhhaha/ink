import type { DecodedImage } from "@ink/assets/experimental/media.ts";
import type { AssetId } from "@ink/assets/identity.ts";
import type { CanonicalMaterialRecord } from "@ink/materials/canonical.ts";
import {
  linear_rgb,
  type LinearRgb,
  srgb_rgba,
  srgb_to_linear,
} from "@ink/materials/color.ts";
import { type Vec3, vec3, vec3_dot, vec3_normalize } from "@ink/math/vector.ts";
import type { Observer } from "@ink/observability/observer.ts";
import type {
  AtmosphereInput,
  EnvironmentSource,
  ExposureInput,
  PrefilteredEnvironment,
} from "../model.ts";
import { environment_id, type EnvironmentId, light_id } from "../identity.ts";

const axes = Object.freeze([
  vec3(1, 0, 0),
  vec3(-1, 0, 0),
  vec3(0, 1, 0),
  vec3(0, -1, 0),
  vec3(0, 0, 1),
  vec3(0, 0, -1),
]);

function immutable<Value>(value: Value): Value {
  const clone = structuredClone(value);
  const freeze = (current: unknown): void => {
    if (
      current === null || typeof current !== "object" ||
      Object.isFrozen(current)
    ) return;
    for (const property of Object.values(current)) freeze(property);
    Object.freeze(current);
  };
  freeze(clone);
  return clone;
}

function sh_basis(direction: Vec3): readonly number[] {
  const { x, y, z } = direction;
  return [
    0.282095,
    0.488603 * y,
    0.488603 * z,
    0.488603 * x,
    1.092548 * x * y,
    1.092548 * y * z,
    0.315392 * (3 * z * z - 1),
    1.092548 * x * z,
    0.546274 * (x * x - y * y),
  ];
}

function validate_radiance(color: LinearRgb, label: string): void {
  for (const [channel, value] of Object.entries(color)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `${label} ${channel} ${String(value)} must be finite and nonnegative`,
      );
    }
  }
}

export function import_environment_image(
  id: EnvironmentId,
  revision: number,
  asset: AssetId<"environment">,
  image: DecodedImage,
): EnvironmentSource {
  if (environment_id(id) !== id) {
    throw new Error(`environment identity ${id} is not canonical`);
  }
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(
      `environment ${id} revision ${revision} must be a nonnegative safe integer`,
    );
  }
  if (
    !Number.isSafeInteger(image.width) || image.width <= 0 ||
    !Number.isSafeInteger(image.height) || image.height <= 0
  ) {
    throw new Error(
      `environment ${id} asset ${asset} dimensions ${image.width}x${image.height} must be positive safe integers`,
    );
  }
  if (image.color_space === "display-p3") {
    throw new Error(
      `environment ${id} asset ${asset} uses display-p3; convert it to linear-srgb or srgb before import`,
    );
  }
  if (image.rgba8.length !== image.width * image.height * 4) {
    throw new Error(
      `environment ${id} asset ${asset} has ${image.rgba8.length} RGBA bytes; expected ${
        image.width * image.height * 4
      }`,
    );
  }
  const pixels = Array.from(
    { length: image.width * image.height },
    (_, index) => {
      const offset = index * 4;
      const r = image.rgba8[offset] / 255;
      const g = image.rgba8[offset + 1] / 255;
      const b = image.rgba8[offset + 2] / 255;
      if (image.color_space === "srgb") {
        const converted = srgb_to_linear(srgb_rgba(r, g, b, 1));
        return linear_rgb(converted.r, converted.g, converted.b);
      }
      return linear_rgb(r, g, b);
    },
  );
  return Object.freeze({
    id,
    revision,
    asset,
    width: image.width,
    height: image.height,
    pixels: Object.freeze(pixels),
  });
}

export function prefilter_environment(
  source: EnvironmentSource,
  roughness_levels: number,
  observer?: Observer,
): PrefilteredEnvironment {
  if (!Number.isSafeInteger(source.revision) || source.revision < 0) {
    throw new Error(
      `environment ${source.id} revision ${source.revision} must be a nonnegative safe integer`,
    );
  }
  if (
    !Number.isSafeInteger(source.width) || source.width <= 0 ||
    !Number.isSafeInteger(source.height) || source.height <= 0
  ) {
    throw new Error(
      `environment ${source.id} dimensions ${source.width}x${source.height} must be positive safe integers`,
    );
  }
  if (source.pixels.length !== source.width * source.height) {
    throw new Error(
      `environment ${source.id} has ${source.pixels.length} pixels; expected ${
        source.width * source.height
      }`,
    );
  }
  if (
    !Number.isSafeInteger(roughness_levels) || roughness_levels < 2 ||
    roughness_levels > 16
  ) {
    throw new Error(
      `environment ${source.id} roughness levels ${roughness_levels} must be an integer within [2, 16]`,
    );
  }
  source.pixels.forEach((color, index) =>
    validate_radiance(color, `environment ${source.id} pixel ${index}`)
  );
  const samples: { direction: Vec3; radiance: LinearRgb; weight: number }[] =
    [];
  const coefficients = Array.from({ length: 9 }, () => [0, 0, 0]);
  let total_weight = 0;
  for (let y = 0; y < source.height; y += 1) {
    const theta = Math.PI * (y + 0.5) / source.height;
    const sin_theta = Math.sin(theta);
    for (let x = 0; x < source.width; x += 1) {
      const phi = Math.PI * 2 * (x + 0.5) / source.width;
      const direction = vec3(
        sin_theta * Math.cos(phi),
        Math.cos(theta),
        sin_theta * Math.sin(phi),
      );
      const radiance = source.pixels[x + y * source.width];
      const weight = sin_theta;
      samples.push({ direction, radiance, weight });
      const basis = sh_basis(direction);
      for (let coefficient = 0; coefficient < 9; coefficient += 1) {
        coefficients[coefficient][0] += radiance.r * basis[coefficient] *
          weight;
        coefficients[coefficient][1] += radiance.g * basis[coefficient] *
          weight;
        coefficients[coefficient][2] += radiance.b * basis[coefficient] *
          weight;
      }
      total_weight += weight;
    }
  }
  const normalization = 4 * Math.PI / total_weight;
  const convolution = [
    Math.PI,
    2 * Math.PI / 3,
    2 * Math.PI / 3,
    2 * Math.PI / 3,
    Math.PI / 4,
    Math.PI / 4,
    Math.PI / 4,
    Math.PI / 4,
    Math.PI / 4,
  ];
  const irradiance_sh = coefficients.map(([r, g, b], index) =>
    vec3(
      r * normalization * convolution[index],
      g * normalization * convolution[index],
      b * normalization * convolution[index],
    )
  );
  const reflection_levels = Array.from(
    { length: roughness_levels },
    (_, index) => {
      const roughness = index / (roughness_levels - 1);
      const exponent = Math.max(0, 2 / Math.max(0.05, roughness) ** 2 - 2);
      const axis_radiance = axes.map((axis) => {
        let r = 0;
        let g = 0;
        let b = 0;
        let weight_sum = 0;
        for (const sample of samples) {
          const lobe = Math.max(0, vec3_dot(axis, sample.direction)) **
            exponent;
          const weight = lobe * sample.weight;
          r += sample.radiance.r * weight;
          g += sample.radiance.g * weight;
          b += sample.radiance.b * weight;
          weight_sum += weight;
        }
        if (weight_sum === 0) return linear_rgb(0, 0, 0);
        return linear_rgb(r / weight_sum, g / weight_sum, b / weight_sum);
      });
      return Object.freeze({
        roughness,
        axis_radiance: Object.freeze(axis_radiance),
      });
    },
  );
  observer?.event("lighting.environment.prefiltered", {
    environment_id: source.id,
    pixel_count: source.pixels.length,
    roughness_levels,
  });
  return Object.freeze({
    id: source.id,
    revision: source.revision,
    irradiance_sh: Object.freeze(irradiance_sh),
    reflection_levels: Object.freeze(reflection_levels),
    split_sum_lut: Object.freeze({ resolution: 128, sample_count: 1_024 }),
  });
}

function interpolate_color(
  left: LinearRgb,
  right: LinearRgb,
  amount: number,
): LinearRgb {
  return linear_rgb(
    left.r + (right.r - left.r) * amount,
    left.g + (right.g - left.g) * amount,
    left.b + (right.b - left.b) * amount,
  );
}

function axis_sample(
  level: PrefilteredEnvironment["reflection_levels"][number],
  direction: Vec3,
): LinearRgb {
  const weights = axes.map((axis) =>
    Math.max(0, vec3_dot(axis, direction)) ** 4
  );
  const sum = weights.reduce((total, weight) => total + weight, 0);
  if (sum === 0) return linear_rgb(0, 0, 0);
  return linear_rgb(
    weights.reduce(
      (total, weight, index) => total + level.axis_radiance[index].r * weight,
      0,
    ) / sum,
    weights.reduce(
      (total, weight, index) => total + level.axis_radiance[index].g * weight,
      0,
    ) / sum,
    weights.reduce(
      (total, weight, index) => total + level.axis_radiance[index].b * weight,
      0,
    ) / sum,
  );
}

export function sample_prefiltered_environment(
  environment: PrefilteredEnvironment,
  direction: Vec3,
  roughness: number,
): LinearRgb {
  if (!Number.isFinite(roughness) || roughness < 0 || roughness > 1) {
    throw new Error(
      `environment ${environment.id} roughness ${roughness} must be within [0, 1]`,
    );
  }
  const normalized = vec3_normalize(direction);
  const scaled = roughness * (environment.reflection_levels.length - 1);
  const lower = Math.floor(scaled);
  const upper = Math.min(environment.reflection_levels.length - 1, lower + 1);
  return interpolate_color(
    axis_sample(environment.reflection_levels[lower], normalized),
    axis_sample(environment.reflection_levels[upper], normalized),
    scaled - lower,
  );
}

export interface ImageBasedLightingResult {
  readonly diffuse: LinearRgb;
  readonly specular: LinearRgb;
  readonly reflected: LinearRgb;
}

export function evaluate_image_based_light(
  material: CanonicalMaterialRecord,
  environment: PrefilteredEnvironment,
  normal: Vec3,
  reflection: Vec3,
  split_sum_scale: number,
  split_sum_bias: number,
): ImageBasedLightingResult {
  if (
    !Number.isFinite(split_sum_scale) || split_sum_scale < 0 ||
    !Number.isFinite(split_sum_bias) || split_sum_bias < 0
  ) {
    throw new Error(
      `environment ${environment.id} split-sum scale ${split_sum_scale} and bias ${split_sum_bias} must be finite and nonnegative`,
    );
  }
  const irradiance = evaluate_irradiance_sh(environment.irradiance_sh, normal);
  const reflection_radiance = sample_prefiltered_environment(
    environment,
    reflection,
    material.parameters.perceptual_roughness,
  );
  const occlusion = material.parameters.occlusion_strength;
  const diffuse = linear_rgb(
    irradiance.r * material.diffuse_color.r * occlusion,
    irradiance.g * material.diffuse_color.g * occlusion,
    irradiance.b * material.diffuse_color.b * occlusion,
  );
  const specular = linear_rgb(
    reflection_radiance.r *
      (material.specular_f0.r * split_sum_scale + split_sum_bias) * occlusion,
    reflection_radiance.g *
      (material.specular_f0.g * split_sum_scale + split_sum_bias) * occlusion,
    reflection_radiance.b *
      (material.specular_f0.b * split_sum_scale + split_sum_bias) * occlusion,
  );
  return Object.freeze({
    diffuse,
    specular,
    reflected: linear_rgb(
      diffuse.r + specular.r,
      diffuse.g + specular.g,
      diffuse.b + specular.b,
    ),
  });
}

export function evaluate_irradiance_sh(
  coefficients: readonly Vec3[],
  normal: Vec3,
): LinearRgb {
  if (coefficients.length !== 9) {
    throw new Error(
      `irradiance needs 9 spherical-harmonic coefficients, received ${coefficients.length}`,
    );
  }
  const basis = sh_basis(vec3_normalize(normal));
  return linear_rgb(
    Math.max(
      0,
      coefficients.reduce(
        (sum, color, index) => sum + color.x * basis[index],
        0,
      ),
    ),
    Math.max(
      0,
      coefficients.reduce(
        (sum, color, index) => sum + color.y * basis[index],
        0,
      ),
    ),
    Math.max(
      0,
      coefficients.reduce(
        (sum, color, index) => sum + color.z * basis[index],
        0,
      ),
    ),
  );
}

export interface ResolvedExposure {
  readonly ev100: number;
  readonly multiplier: number;
}

export function resolve_exposure(
  input: ExposureInput,
  metered_ev100: number,
  previous_ev100: number,
  delta_seconds: number,
): ResolvedExposure {
  if (
    ![metered_ev100, previous_ev100, delta_seconds].every(Number.isFinite) ||
    delta_seconds < 0
  ) {
    throw new Error(
      `exposure metered ${metered_ev100}, previous ${previous_ev100}, and delta ${delta_seconds} must be finite with nonnegative delta`,
    );
  }
  let ev100: number;
  if (input.type === "manual") {
    if (!Number.isFinite(input.ev100)) {
      throw new Error(`manual exposure EV100 ${input.ev100} must be finite`);
    }
    ev100 = input.ev100;
  } else if (input.type === "automatic") {
    if (
      !Number.isFinite(input.minimum_ev100) ||
      !Number.isFinite(input.maximum_ev100) ||
      input.minimum_ev100 > input.maximum_ev100
    ) {
      throw new Error(
        `automatic exposure range [${input.minimum_ev100}, ${input.maximum_ev100}] must be finite and increasing`,
      );
    }
    if (
      !Number.isFinite(input.compensation_ev) ||
      !Number.isFinite(input.brighten_speed) ||
      !Number.isFinite(input.darken_speed) || input.brighten_speed < 0 ||
      input.darken_speed < 0
    ) {
      throw new Error(
        `automatic exposure compensation and adaptation speeds must be finite and nonnegative`,
      );
    }
    const target = Math.max(
      input.minimum_ev100,
      Math.min(input.maximum_ev100, metered_ev100 + input.compensation_ev),
    );
    const speed = target < previous_ev100
      ? input.brighten_speed
      : input.darken_speed;
    const amount = 1 - Math.exp(-speed * delta_seconds);
    ev100 = previous_ev100 + (target - previous_ev100) * amount;
  } else {
    throw new Error(
      `exposure type ${
        JSON.stringify((input as { readonly type?: unknown }).type)
      } is unsupported`,
    );
  }
  const multiplier = 2 ** -ev100;
  if (
    !Number.isFinite(ev100) || !Number.isFinite(multiplier) || multiplier <= 0
  ) {
    throw new Error(
      `exposure EV100 ${ev100} produces invalid multiplier ${multiplier}`,
    );
  }
  return Object.freeze({ ev100, multiplier });
}

export function validate_atmosphere(input: AtmosphereInput): AtmosphereInput {
  if (
    !Number.isFinite(input.planet_radius) || input.planet_radius <= 0 ||
    !Number.isFinite(input.atmosphere_height) || input.atmosphere_height <= 0
  ) {
    throw new Error(
      `atmosphere planet radius ${input.planet_radius} and height ${input.atmosphere_height} must be finite and positive`,
    );
  }
  if (
    !Number.isFinite(input.mie_anisotropy) || input.mie_anisotropy <= -1 ||
    input.mie_anisotropy >= 1
  ) {
    throw new Error(
      `atmosphere Mie anisotropy ${input.mie_anisotropy} must be within (-1, 1)`,
    );
  }
  for (
    const [label, color] of [
      ["Rayleigh scattering", input.rayleigh_scattering],
      ["Mie scattering", input.mie_scattering],
      ["ground albedo", input.ground_albedo],
    ] as const
  ) validate_radiance(color, `atmosphere ${label}`);
  for (const [channel, value] of Object.entries(input.ground_albedo)) {
    if (value > 1) {
      throw new Error(
        `atmosphere ground albedo ${channel} ${value} must be within [0, 1]`,
      );
    }
  }
  const sun = light_id(input.sun);
  return immutable({ ...input, sun });
}

export function atmosphere_transmittance(
  input: AtmosphereInput,
  altitude: number,
  distance: number,
): LinearRgb {
  validate_atmosphere(input);
  if (
    !Number.isFinite(altitude) || altitude < 0 || !Number.isFinite(distance) ||
    distance < 0
  ) {
    throw new Error(
      `atmosphere altitude ${altitude} and distance ${distance} must be finite and nonnegative`,
    );
  }
  const density = Math.exp(-altitude / input.atmosphere_height);
  return linear_rgb(
    Math.exp(
      -(input.rayleigh_scattering.r + input.mie_scattering.r) * density *
        distance,
    ),
    Math.exp(
      -(input.rayleigh_scattering.g + input.mie_scattering.g) * density *
        distance,
    ),
    Math.exp(
      -(input.rayleigh_scattering.b + input.mie_scattering.b) * density *
        distance,
    ),
  );
}
