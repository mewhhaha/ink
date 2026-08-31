import { shader_module_id } from "./identity.ts";
import { create_wgsl_module } from "./module.ts";

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
