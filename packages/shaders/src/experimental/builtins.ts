import { shader_module_id } from "../identity.ts";
import { create_wgsl_module } from "../module.ts";
import { brdf_wgsl, pbr_wgsl } from "../pbr.ts";

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

export const experimental_wgsl_modules = Object.freeze([
  transform_wgsl,
  brdf_wgsl,
  pbr_wgsl,
  shadow_wgsl,
  fog_sky_wgsl,
  terrain_wgsl,
  debug_postprocess_wgsl,
]);
