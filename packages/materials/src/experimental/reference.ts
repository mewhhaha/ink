import {
  type Vec3,
  vec3_add,
  vec3_dot,
  vec3_length,
  vec3_normalize,
} from "@ink/math/vector.ts";
import { linear_rgb, type LinearRgb } from "../color.ts";
import type { CanonicalMaterialRecord } from "../model.ts";

export interface ReferenceBrdfResult {
  readonly diffuse: LinearRgb;
  readonly specular: LinearRgb;
  readonly reflected: LinearRgb;
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

export function evaluate_reference_brdf(
  material: CanonicalMaterialRecord,
  normal: Vec3,
  view: Vec3,
  light: Vec3,
): ReferenceBrdfResult {
  const n = vec3_normalize(normal);
  const v = vec3_normalize(view);
  const l = vec3_normalize(light);
  const normal_view = Math.max(0, vec3_dot(n, v));
  const normal_light = Math.max(0, vec3_dot(n, l));
  if (normal_view === 0 || normal_light === 0) {
    const black = linear_rgb(0, 0, 0);
    return Object.freeze({ diffuse: black, specular: black, reflected: black });
  }
  const half_sum = vec3_add(v, l);
  if (vec3_length(half_sum) === 0) {
    const black = linear_rgb(0, 0, 0);
    return Object.freeze({ diffuse: black, specular: black, reflected: black });
  }
  const half = vec3_normalize(half_sum);
  const normal_half = Math.max(0, vec3_dot(n, half));
  const view_half = Math.max(0, vec3_dot(v, half));
  const roughness = Math.max(0.045, material.parameters.perceptual_roughness);
  const alpha = roughness * roughness;
  const alpha_squared = alpha * alpha;
  const denominator = normal_half * normal_half * (alpha_squared - 1) + 1;
  const distribution = alpha_squared / (Math.PI * denominator * denominator);
  const visibility = smith_visibility(normal_view, normal_light, alpha);
  const specular_scale = distribution * visibility /
    Math.max(4 * normal_view * normal_light, 1e-9) * normal_light;
  const specular = linear_rgb(
    schlick(material.specular_f0.r, view_half) * specular_scale,
    schlick(material.specular_f0.g, view_half) * specular_scale,
    schlick(material.specular_f0.b, view_half) * specular_scale,
  );
  const diffuse = linear_rgb(
    material.diffuse_color.r / Math.PI * normal_light,
    material.diffuse_color.g / Math.PI * normal_light,
    material.diffuse_color.b / Math.PI * normal_light,
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
