import { type Sphere, sphere } from "@ink/geometry/shapes.ts";
import { linear_rgb, type LinearRgb } from "@ink/materials/color.ts";
import {
  type Vec3,
  vec3_dot,
  vec3_length,
  vec3_normalize,
  vec3_subtract,
} from "@ink/math/vector.ts";
import { light_id } from "./identity.ts";
import type { LightDefinition, ShadowPolicy } from "./model.ts";

function finite_nonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} ${String(value)} must be finite and nonnegative`);
  }
}

function positive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} ${String(value)} must be finite and positive`);
  }
}

function validate_shadow(light: string, shadow: ShadowPolicy): void {
  if (shadow.type === "off") return;
  if (![128, 256, 512, 1024, 2048, 4096].includes(shadow.resolution)) {
    throw new Error(
      `light ${light} shadow resolution ${shadow.resolution} is unsupported`,
    );
  }
  finite_nonnegative(shadow.depth_bias, `light ${light} shadow depth bias`);
  finite_nonnegative(shadow.normal_bias, `light ${light} shadow normal bias`);
  if (
    !Number.isSafeInteger(shadow.update_interval_frames) ||
    shadow.update_interval_frames <= 0
  ) {
    throw new Error(
      `light ${light} shadow update interval ${shadow.update_interval_frames} must be a positive safe integer`,
    );
  }
  if (shadow.filter.type === "variance") {
    if (
      !Number.isFinite(shadow.filter.minimum_variance) ||
      shadow.filter.minimum_variance <= 0 ||
      shadow.filter.minimum_variance >= 1
    ) {
      throw new Error(
        `light ${light} shadow minimum variance ${shadow.filter.minimum_variance} must be within (0, 1)`,
      );
    }
  }
}

function immutable<T>(value: T): T {
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

export function create_light(input: LightDefinition): LightDefinition {
  if (light_id(input.id) !== input.id) {
    throw new Error(`light identity ${input.id} is not canonical`);
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new Error(
      `light ${input.id} revision ${input.revision} must be a nonnegative safe integer`,
    );
  }
  if (
    !Number.isSafeInteger(input.layers) || input.layers < 0 ||
    input.layers > 0xffff_ffff
  ) {
    throw new Error(
      `light ${input.id} layers ${input.layers} must be unsigned 32-bit`,
    );
  }
  finite_nonnegative(input.importance, `light ${input.id} importance`);
  for (const [channel, value] of Object.entries(input.color)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(
        `light ${input.id} color ${channel} ${
          String(value)
        } must be within [0, 1]`,
      );
    }
  }
  validate_shadow(input.id, input.shadow);
  if (input.type === "directional") {
    positive(input.illuminance_lux, `light ${input.id} illuminance lux`);
    positive(
      input.angular_diameter_radians,
      `light ${input.id} angular diameter`,
    );
    if (input.angular_diameter_radians >= Math.PI) {
      throw new Error(
        `light ${input.id} angular diameter ${input.angular_diameter_radians} must be less than pi`,
      );
    }
    return immutable({
      ...input,
      layers: input.layers >>> 0,
      direction: vec3_normalize(input.direction),
    });
  }
  if (input.type === "point") {
    positive(input.intensity_candela, `light ${input.id} intensity candela`);
    positive(input.range, `light ${input.id} range`);
    finite_nonnegative(input.source_radius, `light ${input.id} source radius`);
    if (input.source_radius >= input.range) {
      throw new Error(
        `light ${input.id} source radius ${input.source_radius} must be below range ${input.range}`,
      );
    }
    return immutable({ ...input, layers: input.layers >>> 0 });
  }
  if (input.type === "spot") {
    positive(input.intensity_candela, `light ${input.id} intensity candela`);
    positive(input.range, `light ${input.id} range`);
    finite_nonnegative(input.source_radius, `light ${input.id} source radius`);
    if (
      !Number.isFinite(input.inner_angle_radians) ||
      !Number.isFinite(input.outer_angle_radians) ||
      input.inner_angle_radians < 0 ||
      input.inner_angle_radians > input.outer_angle_radians ||
      input.outer_angle_radians <= 0 || input.outer_angle_radians >= Math.PI / 2
    ) {
      throw new Error(
        `light ${input.id} spot angles inner ${input.inner_angle_radians} and outer ${input.outer_angle_radians} must satisfy 0 <= inner <= outer < pi/2`,
      );
    }
    return immutable({
      ...input,
      layers: input.layers >>> 0,
      direction: vec3_normalize(input.direction),
    });
  }
  if (input.type === "rectangular") {
    positive(input.luminance_nits, `light ${input.id} luminance nits`);
    positive(input.range, `light ${input.id} range`);
    positive(input.size.x, `light ${input.id} width`);
    positive(input.size.y, `light ${input.id} height`);
    const normal = vec3_normalize(input.normal);
    const tangent = vec3_normalize(input.tangent);
    if (Math.abs(vec3_dot(normal, tangent)) > 1e-6) {
      throw new Error(
        `light ${input.id} rectangular normal and tangent must be perpendicular`,
      );
    }
    return immutable({ ...input, layers: input.layers >>> 0, normal, tangent });
  }
  if (input.shadow.type !== "off") {
    throw new Error(`environment light ${input.id} cannot cast raster shadows`);
  }
  finite_nonnegative(
    input.intensity,
    `light ${input.id} environment intensity`,
  );
  if (!Number.isFinite(input.rotation_radians)) {
    throw new Error(
      `light ${input.id} environment rotation ${input.rotation_radians} must be finite`,
    );
  }
  if (!Number.isSafeInteger(input.priority)) {
    throw new Error(
      `light ${input.id} environment priority ${input.priority} must be a safe integer`,
    );
  }
  return immutable({ ...input, layers: input.layers >>> 0 });
}

export function light_bounds(light: LightDefinition): Sphere | null {
  if (light.type === "directional" || light.type === "environment") return null;
  const center = light.position;
  const radius = light.type === "rectangular"
    ? Math.sqrt(
      light.range ** 2 + (light.size.x / 2) ** 2 + (light.size.y / 2) ** 2,
    )
    : light.range;
  return sphere(center, radius);
}

function range_attenuation(distance: number, range: number): number {
  if (distance >= range) return 0;
  const ratio = distance / range;
  return Math.max(0, 1 - ratio ** 4) ** 2;
}

export function spot_cone_attenuation(
  light: Extract<LightDefinition, { readonly type: "spot" }>,
  point: Vec3,
): number {
  const from_light = vec3_normalize(vec3_subtract(point, light.position));
  const cosine = vec3_dot(light.direction, from_light);
  const inner = Math.cos(light.inner_angle_radians);
  const outer = Math.cos(light.outer_angle_radians);
  if (cosine <= outer) return 0;
  if (cosine >= inner || inner === outer) return 1;
  const amount = (cosine - outer) / (inner - outer);
  return amount * amount * (3 - 2 * amount);
}

export function incident_illuminance(
  light: LightDefinition,
  point: Vec3,
): LinearRgb {
  let amount = 0;
  if (light.type === "directional") amount = light.illuminance_lux;
  else if (light.type === "point" || light.type === "spot") {
    const distance = vec3_length(vec3_subtract(point, light.position));
    const effective_distance = Math.max(distance, light.source_radius, 1e-6);
    amount = light.intensity_candela /
      (effective_distance * effective_distance) *
      range_attenuation(distance, light.range);
    if (light.type === "spot") amount *= spot_cone_attenuation(light, point);
  } else if (light.type === "rectangular") {
    const offset = vec3_subtract(point, light.position);
    const distance = vec3_length(offset);
    if (distance < light.range && distance > 0) {
      const facing = vec3_dot(light.normal, vec3_normalize(offset));
      const sided = light.two_sided ? Math.abs(facing) : Math.max(0, facing);
      const area = light.size.x * light.size.y;
      amount = light.luminance_nits * Math.PI * area /
        (distance * distance + area) * sided *
        range_attenuation(distance, light.range);
    }
  }
  return linear_rgb(
    light.color.r * amount,
    light.color.g * amount,
    light.color.b * amount,
  );
}

export function light_affects_layers(
  light: LightDefinition,
  layers: number,
): boolean {
  return ((light.layers >>> 0) & (layers >>> 0)) !== 0;
}
