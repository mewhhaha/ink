import { shader_module_id } from "@ink/shaders/identity.ts";
import { create_wgsl_module, type WgslModule } from "@ink/shaders/module.ts";

export const ray_intersection_wgsl = create_wgsl_module({
  id: shader_module_id("ink/ray/intersection"),
  revision: 0,
  source: `
struct InkRayTracingRay {
  origin: vec3f,
  minimum_distance: f32,
  direction: vec3f,
  maximum_distance: f32,
}

struct InkRayTracingTriangleHit {
  distance: f32,
  barycentric_b: f32,
  barycentric_c: f32,
  hit: u32,
}

fn ink_ray_slab_interval(
  origin: f32,
  direction: f32,
  minimum: f32,
  maximum: f32,
  interval: vec2f,
) -> vec2f {
  if (direction == 0.0) {
    if (origin < minimum || origin > maximum) {
      return vec2f(1.0, -1.0);
    }
    return interval;
  }
  let inverse_direction = 1.0 / direction;
  let first = (minimum - origin) * inverse_direction;
  let second = (maximum - origin) * inverse_direction;
  return vec2f(
    max(interval.x, min(first, second)),
    min(interval.y, max(first, second)),
  );
}

fn ink_ray_bounds_distance(
  ray: InkRayTracingRay,
  minimum: vec3f,
  maximum: vec3f,
) -> f32 {
  var interval = vec2f(ray.minimum_distance, ray.maximum_distance);
  interval = ink_ray_slab_interval(
    ray.origin.x,
    ray.direction.x,
    minimum.x,
    maximum.x,
    interval,
  );
  interval = ink_ray_slab_interval(
    ray.origin.y,
    ray.direction.y,
    minimum.y,
    maximum.y,
    interval,
  );
  interval = ink_ray_slab_interval(
    ray.origin.z,
    ray.direction.z,
    minimum.z,
    maximum.z,
    interval,
  );
  if (interval.x > interval.y) {
    return -1.0;
  }
  return interval.x;
}

fn ink_ray_triangle_intersection(
  ray: InkRayTracingRay,
  a: vec3f,
  b: vec3f,
  c: vec3f,
) -> InkRayTracingTriangleHit {
  let edge_ab = b - a;
  let edge_ac = c - a;
  let perpendicular = cross(ray.direction, edge_ac);
  let determinant = dot(edge_ab, perpendicular);
  if (abs(determinant) <= 0.00000001) {
    return InkRayTracingTriangleHit(-1.0, 0.0, 0.0, 0u);
  }
  let inverse_determinant = 1.0 / determinant;
  let origin_offset = ray.origin - a;
  let barycentric_b = dot(origin_offset, perpendicular) * inverse_determinant;
  let crossing = cross(origin_offset, edge_ab);
  let barycentric_c = dot(ray.direction, crossing) * inverse_determinant;
  let distance = dot(edge_ac, crossing) * inverse_determinant;
  let inside = barycentric_b >= 0.0 && barycentric_c >= 0.0 &&
    barycentric_b + barycentric_c <= 1.0 &&
    distance >= ray.minimum_distance && distance <= ray.maximum_distance;
  return InkRayTracingTriangleHit(distance, barycentric_b, barycentric_c, select(0u, 1u, inside));
}`,
  symbols: [
    { name: "InkRayTracingRay", kind: "struct", exported: true },
    { name: "InkRayTracingTriangleHit", kind: "struct", exported: true },
    { name: "ink_ray_bounds_distance", kind: "function", exported: true },
    {
      name: "ink_ray_triangle_intersection",
      kind: "function",
      exported: true,
    },
  ],
});

export const ray_stackless_traversal_wgsl = create_wgsl_module({
  id: shader_module_id("ink/ray/stackless-traversal"),
  revision: 0,
  source: `
struct InkRayTracingBvhNode {
  minimum: vec3f,
  left: u32,
  maximum: vec3f,
  right: u32,
  first_index: u32,
  index_count: u32,
  escape: u32,
  kind: u32,
}

fn ink_ray_stackless_next(
  node: InkRayTracingBvhNode,
  ray: InkRayTracingRay,
) -> u32 {
  let intersects_bounds = ink_ray_bounds_distance(
    ray,
    node.minimum,
    node.maximum,
  ) >= 0.0;
  if (!intersects_bounds || node.kind == 1u) {
    return node.escape;
  }
  return node.left;
}`,
  dependencies: [{
    module: ray_intersection_wgsl.id,
    symbols: ["InkRayTracingRay", "ink_ray_bounds_distance"],
  }],
  symbols: [
    { name: "InkRayTracingBvhNode", kind: "struct", exported: true },
    { name: "ink_ray_stackless_next", kind: "function", exported: true },
  ],
});

export const ray_ggx_sampling_wgsl = create_wgsl_module({
  id: shader_module_id("ink/ray/ggx-sampling"),
  revision: 0,
  source: `
fn ink_ray_ggx_distribution(normal_dot_half: f32, alpha: f32) -> f32 {
  let alpha_squared = alpha * alpha;
  let denominator = normal_dot_half * normal_dot_half * (alpha_squared - 1.0) + 1.0;
  return alpha_squared / max(3.14159265359 * denominator * denominator, 0.000001);
}

fn ink_ray_ggx_sample_half_vector(random_sample: vec2f, alpha: f32) -> vec3f {
  let angle = 6.28318530718 * random_sample.x;
  let alpha_squared = alpha * alpha;
  let cosine = sqrt((1.0 - random_sample.y) / max(1.0 + (alpha_squared - 1.0) * random_sample.y, 0.000001));
  let sine = sqrt(max(0.0, 1.0 - cosine * cosine));
  return vec3f(cos(angle) * sine, sin(angle) * sine, cosine);
}`,
  symbols: [
    { name: "ink_ray_ggx_distribution", kind: "function", exported: true },
    {
      name: "ink_ray_ggx_sample_half_vector",
      kind: "function",
      exported: true,
    },
  ],
});

export const ray_direct_light_sampling_wgsl = create_wgsl_module({
  id: shader_module_id("ink/ray/direct-light-sampling"),
  revision: 0,
  source: `
struct InkRayTracingDirectLightSample {
  direction: vec3f,
  distance: f32,
  radiance: vec3f,
  probability_density: f32,
}

fn ink_ray_sample_point_light(
  surface_position: vec3f,
  light_position: vec3f,
  intensity: vec3f,
) -> InkRayTracingDirectLightSample {
  let offset = light_position - surface_position;
  let distance_squared = max(dot(offset, offset), 0.000001);
  let distance = sqrt(distance_squared);
  return InkRayTracingDirectLightSample(
    offset / distance,
    distance,
    intensity / distance_squared,
    1.0,
  );
}

fn ink_ray_sample_rectangular_light(
  surface_position: vec3f,
  light_position: vec3f,
  light_normal: vec3f,
  light_tangent: vec3f,
  light_size: vec2f,
  luminance: vec3f,
  two_sided: bool,
  random_sample: vec2f,
) -> InkRayTracingDirectLightSample {
  let normalized_normal = normalize(light_normal);
  let normalized_tangent = normalize(light_tangent);
  let bitangent = normalize(cross(normalized_normal, normalized_tangent));
  let sampled_position = light_position +
    normalized_tangent * ((random_sample.x - 0.5) * light_size.x) +
    bitangent * ((random_sample.y - 0.5) * light_size.y);
  let offset = sampled_position - surface_position;
  let distance_squared = max(dot(offset, offset), 0.000001);
  let distance = sqrt(distance_squared);
  let direction = offset / distance;
  let facing = dot(normalized_normal, -direction);
  let emission_cosine = select(max(facing, 0.0), abs(facing), two_sided);
  let area = max(light_size.x * light_size.y, 0.000001);
  return InkRayTracingDirectLightSample(
    direction,
    distance,
    luminance * emission_cosine / distance_squared,
    1.0 / area,
  );
}`,
  symbols: [
    {
      name: "InkRayTracingDirectLightSample",
      kind: "struct",
      exported: true,
    },
    { name: "ink_ray_sample_point_light", kind: "function", exported: true },
    {
      name: "ink_ray_sample_rectangular_light",
      kind: "function",
      exported: true,
    },
  ],
});

export const ray_progressive_accumulation_wgsl = create_wgsl_module({
  id: shader_module_id("ink/ray/progressive-accumulation"),
  revision: 0,
  source: `
fn ink_ray_progressive_accumulation(
  history: vec3f,
  radiance_sample: vec3f,
  accumulated_samples: u32,
) -> vec3f {
  let previous_weight = f32(accumulated_samples);
  return (history * previous_weight + radiance_sample) / (previous_weight + 1.0);
}`,
  symbols: [{
    name: "ink_ray_progressive_accumulation",
    kind: "function",
    exported: true,
  }],
});

export const ray_variance_wgsl = create_wgsl_module({
  id: shader_module_id("ink/ray/variance"),
  revision: 0,
  source: `
fn ink_ray_luminance_variance(first_moment: f32, second_moment: f32) -> f32 {
  return max(second_moment - first_moment * first_moment, 0.0);
}

fn ink_ray_update_moments(previous: vec2f, luminance: f32, sample_count: u32) -> vec2f {
  let weight = 1.0 / f32(sample_count + 1u);
  let sample_moments = vec2f(luminance, luminance * luminance);
  return mix(previous, sample_moments, weight);
}`,
  symbols: [
    { name: "ink_ray_luminance_variance", kind: "function", exported: true },
    { name: "ink_ray_update_moments", kind: "function", exported: true },
  ],
});

export const ray_edge_aware_denoise_wgsl = create_wgsl_module({
  id: shader_module_id("ink/ray/edge-aware-denoise"),
  revision: 0,
  source: `
fn ink_ray_edge_aware_weight(
  center_depth: f32,
  sample_depth: f32,
  center_normal: vec3f,
  sample_normal: vec3f,
  first_moment: f32,
  second_moment: f32,
) -> f32 {
  let depth_weight = exp(-abs(center_depth - sample_depth) * 32.0);
  let normal_weight = pow(max(dot(center_normal, sample_normal), 0.0), 32.0);
  let variance = ink_ray_luminance_variance(first_moment, second_moment);
  let variance_weight = 1.0 / (1.0 + variance * 8.0);
  return depth_weight * normal_weight * variance_weight;
}`,
  dependencies: [{
    module: ray_variance_wgsl.id,
    symbols: ["ink_ray_luminance_variance"],
  }],
  symbols: [{
    name: "ink_ray_edge_aware_weight",
    kind: "function",
    exported: true,
  }],
});

export const ray_tracing_wgsl_modules: readonly WgslModule[] = Object.freeze([
  ray_intersection_wgsl,
  ray_stackless_traversal_wgsl,
  ray_ggx_sampling_wgsl,
  ray_direct_light_sampling_wgsl,
  ray_progressive_accumulation_wgsl,
  ray_variance_wgsl,
  ray_edge_aware_denoise_wgsl,
]);
