import { linear_rgb, type LinearRgb } from "@ink/materials/color.ts";
import type { CanonicalMaterialRecord } from "@ink/materials/canonical.ts";
import {
  type Vec3,
  vec3_add,
  vec3_dot,
  vec3_length,
  vec3_normalize,
  vec3_scale,
  vec3_subtract,
} from "@ink/math/vector.ts";
import { incident_illuminance } from "../light.ts";
import type { LightDefinition } from "../model.ts";

export interface DirectLightingResult {
  readonly diffuse: LinearRgb;
  readonly specular: LinearRgb;
  readonly clearcoat: LinearRgb;
  readonly reflected: LinearRgb;
}

function black(): LinearRgb {
  return linear_rgb(0, 0, 0);
}

export function lambertian_diffuse(
  diffuse_color: LinearRgb,
  normal_light: number,
): LinearRgb {
  const cosine = Math.max(0, Math.min(1, normal_light));
  return linear_rgb(
    diffuse_color.r / Math.PI * cosine,
    diffuse_color.g / Math.PI * cosine,
    diffuse_color.b / Math.PI * cosine,
  );
}

function schlick(f0: number, view_half: number): number {
  return f0 + (1 - f0) * (1 - view_half) ** 5;
}

function smith_visibility(
  normal_view: number,
  normal_light: number,
  alpha: number,
): number {
  const k = (alpha + 1) ** 2 / 8;
  const view = normal_view / (normal_view * (1 - k) + k);
  const light = normal_light / (normal_light * (1 - k) + k);
  return view * light;
}

export function microfacet_specular(
  f0: LinearRgb,
  perceptual_roughness: number,
  normal: Vec3,
  view: Vec3,
  light: Vec3,
): LinearRgb {
  const n = vec3_normalize(normal);
  const v = vec3_normalize(view);
  const l = vec3_normalize(light);
  const normal_view = Math.max(0, vec3_dot(n, v));
  const normal_light = Math.max(0, vec3_dot(n, l));
  if (normal_view === 0 || normal_light === 0) return black();
  const half_sum = vec3_add(v, l);
  if (vec3_length(half_sum) === 0) return black();
  const half = vec3_normalize(half_sum);
  const normal_half = Math.max(0, vec3_dot(n, half));
  const view_half = Math.max(0, vec3_dot(v, half));
  const roughness = Math.max(0.045, Math.min(1, perceptual_roughness));
  const alpha = roughness * roughness;
  const alpha_squared = alpha * alpha;
  const denominator = normal_half * normal_half * (alpha_squared - 1) + 1;
  const distribution = alpha_squared / (Math.PI * denominator * denominator);
  const visibility = smith_visibility(normal_view, normal_light, alpha);
  const scale = distribution * visibility /
    Math.max(4 * normal_view * normal_light, 1e-9) * normal_light;
  return linear_rgb(
    schlick(f0.r, view_half) * scale,
    schlick(f0.g, view_half) * scale,
    schlick(f0.b, view_half) * scale,
  );
}

function direction_to_light(light: LightDefinition, point: Vec3): Vec3 | null {
  if (light.type === "directional") return vec3_scale(light.direction, -1);
  if (
    light.type === "point" || light.type === "spot" ||
    light.type === "rectangular"
  ) {
    const offset = vec3_subtract(light.position, point);
    return vec3_length(offset) === 0 ? null : vec3_normalize(offset);
  }
  return null;
}

function multiply(left: LinearRgb, right: LinearRgb, scale: number): LinearRgb {
  return linear_rgb(
    left.r * right.r * scale,
    left.g * right.g * scale,
    left.b * right.b * scale,
  );
}

export function evaluate_direct_light(
  material: CanonicalMaterialRecord,
  light: LightDefinition,
  point: Vec3,
  normal: Vec3,
  view: Vec3,
  shadow_visibility = 1,
): DirectLightingResult {
  if (
    !Number.isFinite(shadow_visibility) || shadow_visibility < 0 ||
    shadow_visibility > 1
  ) {
    throw new Error(
      `light ${light.id} shadow visibility ${shadow_visibility} must be within [0, 1]`,
    );
  }
  if (material.stylized?.type === "unlit") {
    const zero = black();
    return Object.freeze({
      diffuse: zero,
      specular: zero,
      clearcoat: zero,
      reflected: zero,
    });
  }
  const direction = direction_to_light(light, point);
  if (direction === null) {
    const zero = black();
    return Object.freeze({
      diffuse: zero,
      specular: zero,
      clearcoat: zero,
      reflected: zero,
    });
  }
  const n = vec3_normalize(normal);
  const normal_light = Math.max(0, vec3_dot(n, direction));
  const incident = incident_illuminance(light, point);
  const diffuse_brdf = lambertian_diffuse(material.diffuse_color, normal_light);
  const specular_brdf = microfacet_specular(
    material.specular_f0,
    material.parameters.perceptual_roughness,
    n,
    view,
    direction,
  );
  const clearcoat_brdf = material.parameters.clearcoat === 0
    ? black()
    : microfacet_specular(
      linear_rgb(0.04, 0.04, 0.04),
      material.parameters.clearcoat_roughness,
      n,
      view,
      direction,
    );
  const diffuse = multiply(diffuse_brdf, incident, shadow_visibility);
  const specular = multiply(specular_brdf, incident, shadow_visibility);
  const clearcoat = multiply(
    clearcoat_brdf,
    incident,
    shadow_visibility * material.parameters.clearcoat,
  );
  return Object.freeze({
    diffuse,
    specular,
    clearcoat,
    reflected: linear_rgb(
      diffuse.r + specular.r + clearcoat.r,
      diffuse.g + specular.g + clearcoat.g,
      diffuse.b + specular.b + clearcoat.b,
    ),
  });
}
