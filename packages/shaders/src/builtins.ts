import { shader_module_id } from "./identity.ts";
import { create_wgsl_module } from "./module.ts";

export const transform_wgsl = create_wgsl_module({
  id: shader_module_id("ink/transforms"),
  revision: 0,
  symbols: [
    { name: "ink_transform_position", kind: "function", exported: true },
    { name: "ink_transform_normal", kind: "function", exported: true },
  ],
  source: `
fn ink_transform_position(matrix: mat4x4f, position: vec3f) -> vec4f {
  return matrix * vec4f(position, 1.0);
}

fn ink_transform_normal(matrix: mat3x3f, normal: vec3f) -> vec3f {
  return normalize(matrix * normal);
}`,
});

export const brdf_wgsl = create_wgsl_module({
  id: shader_module_id("ink/brdf"),
  revision: 0,
  symbols: [
    { name: "ink_distribution_ggx", kind: "function", exported: true },
    { name: "ink_fresnel_schlick", kind: "function", exported: true },
    { name: "ink_geometry_smith", kind: "function", exported: true },
  ],
  source: `
fn ink_distribution_ggx(no_h: f32, roughness: f32) -> f32 {
  let alpha = roughness * roughness;
  let alpha_squared = alpha * alpha;
  let denominator = no_h * no_h * (alpha_squared - 1.0) + 1.0;
  return alpha_squared / max(3.14159265 * denominator * denominator, 0.00001);
}

fn ink_fresnel_schlick(vo_h: f32, f0: vec3f) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(1.0 - vo_h, 5.0);
}

fn ink_geometry_smith(no_v: f32, no_l: f32, roughness: f32) -> f32 {
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let view = no_v / max(no_v * (1.0 - k) + k, 0.00001);
  let light = no_l / max(no_l * (1.0 - k) + k, 0.00001);
  return view * light;
}`,
});

export const pbr_wgsl = create_wgsl_module({
  id: shader_module_id("ink/pbr"),
  revision: 0,
  dependencies: [{
    module: brdf_wgsl.id,
    symbols: [
      "ink_distribution_ggx",
      "ink_fresnel_schlick",
      "ink_geometry_smith",
    ],
  }],
  symbols: [{ name: "ink_evaluate_pbr", kind: "function", exported: true }],
  source: `
fn ink_evaluate_pbr(
  base_color: vec3f,
  metallic: f32,
  roughness: f32,
  specular_f0: vec3f,
  normal: vec3f,
  view: vec3f,
  light: vec3f,
) -> vec3f {
  let half_vector = normalize(view + light);
  let no_v = max(dot(normal, view), 0.00001);
  let no_l = max(dot(normal, light), 0.0);
  let no_h = max(dot(normal, half_vector), 0.0);
  let vo_h = max(dot(view, half_vector), 0.0);
  let distribution = ink_distribution_ggx(no_h, roughness);
  let fresnel = ink_fresnel_schlick(vo_h, specular_f0);
  let geometry = ink_geometry_smith(no_v, no_l, roughness);
  let specular = distribution * geometry * fresnel / max(4.0 * no_v * no_l, 0.00001);
  let diffuse = (vec3f(1.0) - fresnel) * (1.0 - metallic) * base_color / 3.14159265;
  return (diffuse + specular) * no_l;
}`,
});

export const shadow_wgsl = create_wgsl_module({
  id: shader_module_id("ink/shadows"),
  revision: 0,
  symbols: [
    { name: "ink_shadow_bias", kind: "function", exported: true },
    { name: "ink_variance_shadow", kind: "function", exported: true },
  ],
  source: `
fn ink_shadow_bias(no_l: f32, depth_bias: f32, normal_bias: f32) -> f32 {
  return depth_bias + normal_bias * (1.0 - clamp(no_l, 0.0, 1.0));
}

fn ink_variance_shadow(moments: vec2f, receiver_depth: f32, minimum_variance: f32) -> f32 {
  if (receiver_depth <= moments.x) {
    return 1.0;
  }
  let variance = max(moments.y - moments.x * moments.x, minimum_variance);
  let difference = receiver_depth - moments.x;
  return variance / (variance + difference * difference);
}`,
});

export const fog_sky_wgsl = create_wgsl_module({
  id: shader_module_id("ink/fog-sky"),
  revision: 0,
  symbols: [
    { name: "ink_exponential_fog", kind: "function", exported: true },
    { name: "ink_sky_gradient", kind: "function", exported: true },
  ],
  source: `
fn ink_exponential_fog(distance: f32, density: f32) -> f32 {
  return clamp(1.0 - exp(-max(distance, 0.0) * max(density, 0.0)), 0.0, 1.0);
}

fn ink_sky_gradient(direction: vec3f, horizon: vec3f, zenith: vec3f) -> vec3f {
  let amount = clamp(direction.y * 0.5 + 0.5, 0.0, 1.0);
  return mix(horizon, zenith, amount);
}`,
});

export const terrain_wgsl = create_wgsl_module({
  id: shader_module_id("ink/terrain"),
  revision: 0,
  overrides: [{ name: "INK_TERRAIN_SKIRT", type: "bool", default_value: true }],
  symbols: [
    { name: "ink_terrain_height_blend", kind: "function", exported: true },
    { name: "ink_terrain_skirt_position", kind: "function", exported: true },
  ],
  source: `
override INK_TERRAIN_SKIRT: bool = true;

fn ink_terrain_height_blend(first: f32, second: f32, amount: f32) -> f32 {
  return mix(first, second, clamp(amount, 0.0, 1.0));
}

fn ink_terrain_skirt_position(position: vec3f, edge: f32, depth: f32) -> vec3f {
  if (INK_TERRAIN_SKIRT && edge > 0.5) {
    return position - vec3f(0.0, max(depth, 0.0), 0.0);
  }
  return position;
}`,
});

export const debug_postprocess_wgsl = create_wgsl_module({
  id: shader_module_id("ink/debug-postprocess"),
  revision: 0,
  symbols: [
    { name: "ink_reinhard_tone_map", kind: "function", exported: true },
    { name: "ink_debug_normal", kind: "function", exported: true },
    { name: "ink_linear_to_srgb", kind: "function", exported: true },
  ],
  source: `
fn ink_reinhard_tone_map(color: vec3f) -> vec3f {
  return color / (vec3f(1.0) + color);
}

fn ink_debug_normal(normal: vec3f) -> vec3f {
  return normalize(normal) * 0.5 + vec3f(0.5);
}

fn ink_linear_to_srgb(color: vec3f) -> vec3f {
  let low = color * 12.92;
  let high = 1.055 * pow(max(color, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, color <= vec3f(0.0031308));
}`,
});

export const reusable_wgsl_modules = Object.freeze([
  transform_wgsl,
  brdf_wgsl,
  pbr_wgsl,
  shadow_wgsl,
  fog_sky_wgsl,
  terrain_wgsl,
  debug_postprocess_wgsl,
]);
