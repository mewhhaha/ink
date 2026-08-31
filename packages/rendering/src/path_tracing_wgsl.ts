import { shader_module_id } from "@ink/shaders/identity.ts";
import { compose_wgsl_modules } from "@ink/shaders/compose.ts";
import { create_wgsl_module } from "@ink/shaders/module.ts";
import {
  ray_direct_light_sampling_wgsl,
  ray_edge_aware_denoise_wgsl,
  ray_ggx_sampling_wgsl,
  ray_intersection_wgsl,
  ray_progressive_accumulation_wgsl,
  ray_stackless_traversal_wgsl,
  ray_tracing_wgsl_modules,
  ray_variance_wgsl,
} from "@ink/ray-tracing/wgsl.ts";

const path_trace_module = create_wgsl_module({
  id: shader_module_id("ink/rendering/path-trace"),
  revision: 0,
  source: `
const INK_MISSING_NODE = 0xffffffffu;

struct InkPackedTriangle {
  a: vec3f,
  material_index: u32,
  b: vec3f,
  source_triangle: u32,
  c: vec3f,
  attribute_flags: u32,
  texture_a_b: vec4f,
  texture_c: vec2f,
  attribute_padding: vec2f,
  normal_a: vec3f,
  normal_a_padding: f32,
  normal_b: vec3f,
  normal_b_padding: f32,
  normal_c: vec3f,
  normal_c_padding: f32,
}

struct InkPackedGeometry {
  blas_root: u32,
  first_triangle: u32,
  triangle_count: u32,
  revision: u32,
}

struct InkPackedInstance {
  transform: mat4x4f,
  inverse_transform: mat4x4f,
  geometry_index: u32,
  revision: u32,
  padding: vec2u,
}

struct InkPackedMaterial {
  base_color_metallic: vec4f,
  emissive_roughness: vec4f,
  specular_emissive_strength: vec4f,
  texture_layers_scale: vec4f,
  normal_texture: vec4f,
}

struct InkPackedLight {
  position_range: vec4f,
  direction_type: vec4f,
  color_intensity: vec4f,
  tangent_source: vec4f,
  shape: vec4f,
}

struct InkPathUniform {
  inverse_view_projection: mat4x4f,
  camera_position: vec4f,
  clear_color: vec4f,
  ambient_fog_density: vec4f,
  fog_color: vec4f,
  dimensions: vec4u,
  counts: vec4u,
  sequence: vec4u,
}

struct InkSceneHit {
  distance: f32,
  instance_index: u32,
  triangle_index: u32,
  hit: u32,
  barycentric_b: f32,
  barycentric_c: f32,
  padding: vec2f,
}

struct InkBlasHit {
  distance: f32,
  triangle_index: u32,
  barycentric_b: f32,
  barycentric_c: f32,
}

@group(0) @binding(0) var<uniform> path: InkPathUniform;
@group(0) @binding(1) var<storage, read> triangles: array<InkPackedTriangle>;
@group(0) @binding(2) var<storage, read> blas: array<InkRayTracingBvhNode>;
@group(0) @binding(3) var<storage, read> blas_indices: array<u32>;
@group(0) @binding(4) var<storage, read> geometries: array<InkPackedGeometry>;
@group(0) @binding(5) var<storage, read> instances: array<InkPackedInstance>;
@group(0) @binding(6) var<storage, read> tlas: array<InkRayTracingBvhNode>;
@group(0) @binding(7) var<storage, read> tlas_indices: array<u32>;
@group(0) @binding(8) var<storage, read> surface_records: array<vec4f>;
@group(0) @binding(9) var accumulation_history: texture_2d<f32>;
@group(0) @binding(10) var accumulation_output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(11) var depth_output: texture_storage_2d<r32float, write>;
@group(0) @binding(12) var normal_output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(13) var moments_history: texture_2d<f32>;
@group(0) @binding(14) var moments_output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(15) var base_color_textures: texture_2d_array<f32>;
@group(0) @binding(16) var normal_textures: texture_2d_array<f32>;
@group(0) @binding(17) var material_sampler: sampler;

fn ink_hash(value: u32) -> u32 {
  var result = value;
  result = (result ^ 61u) ^ (result >> 16u);
  result *= 9u;
  result ^= result >> 4u;
  result *= 0x27d4eb2du;
  return result ^ (result >> 15u);
}

fn ink_random(seed: ptr<function, u32>) -> f32 {
  *seed = ink_hash(*seed);
  return f32(*seed) / 4294967296.0;
}

fn ink_material(index: u32) -> InkPackedMaterial {
  let first = index * 5u;
  return InkPackedMaterial(
    surface_records[first],
    surface_records[first + 1u],
    surface_records[first + 2u],
    surface_records[first + 3u],
    surface_records[first + 4u],
  );
}

fn ink_light(index: u32) -> InkPackedLight {
  let first = path.sequence.y * 5u + index * 5u;
  return InkPackedLight(
    surface_records[first],
    surface_records[first + 1u],
    surface_records[first + 2u],
    surface_records[first + 3u],
    surface_records[first + 4u],
  );
}

fn ink_local_ray(ray: InkRayTracingRay, inverse_transform: mat4x4f) -> InkRayTracingRay {
  let local_origin = inverse_transform * vec4f(ray.origin, 1.0);
  let local_direction = inverse_transform * vec4f(ray.direction, 0.0);
  return InkRayTracingRay(
    local_origin.xyz,
    ray.minimum_distance,
    local_direction.xyz,
    ray.maximum_distance,
  );
}

fn ink_trace_blas(
  ray: InkRayTracingRay,
  root: u32,
) -> InkBlasHit {
  var node_index = root;
  var closest_distance = ray.maximum_distance;
  var closest_triangle = INK_MISSING_NODE;
  var closest_barycentric_b = 0.0;
  var closest_barycentric_c = 0.0;
  loop {
    if (node_index == INK_MISSING_NODE) {
      break;
    }
    let node = blas[node_index];
    if (ink_ray_bounds_distance(ray, node.minimum, node.maximum) >= 0.0 && node.kind == 1u) {
      for (var offset = 0u; offset < node.index_count; offset += 1u) {
        let triangle_index = blas_indices[node.first_index + offset];
        let triangle = triangles[triangle_index];
        let limited_ray = InkRayTracingRay(
          ray.origin,
          ray.minimum_distance,
          ray.direction,
          closest_distance,
        );
        let hit = ink_ray_triangle_intersection(
          limited_ray,
          triangle.a,
          triangle.b,
          triangle.c,
        );
        if (hit.hit == 1u && hit.distance < closest_distance) {
          closest_distance = hit.distance;
          closest_triangle = triangle_index;
          closest_barycentric_b = hit.barycentric_b;
          closest_barycentric_c = hit.barycentric_c;
        }
      }
    }
    node_index = ink_ray_stackless_next(node, ray);
  }
  return InkBlasHit(
    closest_distance,
    closest_triangle,
    closest_barycentric_b,
    closest_barycentric_c,
  );
}

fn ink_trace_scene(ray: InkRayTracingRay) -> InkSceneHit {
  if (path.counts.x == 0u || path.counts.z == INK_MISSING_NODE) {
    return InkSceneHit(ray.maximum_distance, 0u, 0u, 0u, 0.0, 0.0, vec2f(0.0));
  }
  var node_index = path.counts.z;
  var closest = InkSceneHit(
    ray.maximum_distance,
    0u,
    0u,
    0u,
    0.0,
    0.0,
    vec2f(0.0),
  );
  loop {
    if (node_index == INK_MISSING_NODE) {
      break;
    }
    let node = tlas[node_index];
    if (ink_ray_bounds_distance(ray, node.minimum, node.maximum) >= 0.0 && node.kind == 1u) {
      for (var offset = 0u; offset < node.index_count; offset += 1u) {
        let instance_index = tlas_indices[node.first_index + offset];
        let instance = instances[instance_index];
        let geometry = geometries[instance.geometry_index];
        let limited_ray = InkRayTracingRay(
          ray.origin,
          ray.minimum_distance,
          ray.direction,
          closest.distance,
        );
        let local_result = ink_trace_blas(ink_local_ray(limited_ray, instance.inverse_transform), geometry.blas_root);
        if (local_result.triangle_index != INK_MISSING_NODE && local_result.distance < closest.distance) {
          closest = InkSceneHit(
            local_result.distance,
            instance_index,
            local_result.triangle_index,
            1u,
            local_result.barycentric_b,
            local_result.barycentric_c,
            vec2f(0.0),
          );
        }
      }
    }
    node_index = ink_ray_stackless_next(node, ray);
  }
  return closest;
}

fn ink_world_normal(hit: InkSceneHit) -> vec3f {
  let triangle = triangles[hit.triangle_index];
  let local_geometric_normal = normalize(cross(triangle.b - triangle.a, triangle.c - triangle.a));
  var local_shading_normal = local_geometric_normal;
  if ((triangle.attribute_flags & 2u) != 0u) {
    let barycentric_a = 1.0 - hit.barycentric_b - hit.barycentric_c;
    local_shading_normal = normalize(
      triangle.normal_a * barycentric_a +
      triangle.normal_b * hit.barycentric_b +
      triangle.normal_c * hit.barycentric_c
    );
  }
  let instance = instances[hit.instance_index];
  let normal_transform = transpose(mat3x3f(
    instance.inverse_transform[0].xyz,
    instance.inverse_transform[1].xyz,
    instance.inverse_transform[2].xyz,
  ));
  let world_geometric_normal = normalize(normal_transform * local_geometric_normal);
  var world_shading_normal = normalize(normal_transform * local_shading_normal);
  if (dot(world_shading_normal, world_geometric_normal) < 0.0) {
    world_shading_normal = -world_shading_normal;
  }
  return world_shading_normal;
}

fn ink_texture_coordinate(hit: InkSceneHit) -> vec2f {
  let triangle = triangles[hit.triangle_index];
  let barycentric_a = 1.0 - hit.barycentric_b - hit.barycentric_c;
  return
    triangle.texture_a_b.xy * barycentric_a +
    triangle.texture_a_b.zw * hit.barycentric_b +
    triangle.texture_c * hit.barycentric_c;
}

fn ink_texture_array_coordinate(
  coordinate: vec2f,
  scale: vec2f,
  dimensions: vec2u,
) -> vec2f {
  let half_texel = 0.5 / vec2f(dimensions);
  return clamp(fract(coordinate) * scale, half_texel, scale - half_texel);
}

fn ink_base_color(hit: InkSceneHit, material: InkPackedMaterial) -> vec3f {
  let triangle = triangles[hit.triangle_index];
  if (material.texture_layers_scale.x < 0.0 || (triangle.attribute_flags & 1u) == 0u) {
    return material.base_color_metallic.rgb;
  }
  let coordinate = ink_texture_array_coordinate(
    ink_texture_coordinate(hit),
    material.texture_layers_scale.zw,
    textureDimensions(base_color_textures),
  );
  return material.base_color_metallic.rgb * textureSampleLevel(
    base_color_textures,
    material_sampler,
    coordinate,
    i32(material.texture_layers_scale.x),
    0.0,
  ).rgb;
}

fn ink_surface_normal(hit: InkSceneHit, material: InkPackedMaterial) -> vec3f {
  let world_normal = ink_world_normal(hit);
  let triangle = triangles[hit.triangle_index];
  if (material.texture_layers_scale.y < 0.0 || (triangle.attribute_flags & 1u) == 0u) {
    return world_normal;
  }
  let uv_a = triangle.texture_a_b.xy;
  let uv_b = triangle.texture_a_b.zw;
  let uv_c = triangle.texture_c;
  let edge_ab = triangle.b - triangle.a;
  let edge_ac = triangle.c - triangle.a;
  let uv_ab = uv_b - uv_a;
  let uv_ac = uv_c - uv_a;
  let determinant = uv_ab.x * uv_ac.y - uv_ab.y * uv_ac.x;
  if (abs(determinant) <= 0.000001) {
    return world_normal;
  }
  let reciprocal = 1.0 / determinant;
  let local_tangent = (edge_ab * uv_ac.y - edge_ac * uv_ab.y) * reciprocal;
  let local_bitangent = (edge_ac * uv_ab.x - edge_ab * uv_ac.x) * reciprocal;
  let instance = instances[hit.instance_index];
  let linear_transform = mat3x3f(
    instance.transform[0].xyz,
    instance.transform[1].xyz,
    instance.transform[2].xyz,
  );
  var tangent = normalize(linear_transform * local_tangent);
  tangent = normalize(tangent - world_normal * dot(world_normal, tangent));
  let transformed_bitangent = normalize(linear_transform * local_bitangent);
  let handedness = select(-1.0, 1.0, dot(cross(world_normal, tangent), transformed_bitangent) >= 0.0);
  let bitangent = cross(world_normal, tangent) * handedness;
  let coordinate = ink_texture_array_coordinate(
    ink_texture_coordinate(hit),
    material.normal_texture.xy,
    textureDimensions(normal_textures),
  );
  var tangent_normal = textureSampleLevel(
    normal_textures,
    material_sampler,
    coordinate,
    i32(material.texture_layers_scale.y),
    0.0,
  ).xyz * 2.0 - 1.0;
  tangent_normal.x *= material.normal_texture.z;
  tangent_normal.y *= material.normal_texture.z;
  return normalize(mat3x3f(tangent, bitangent, world_normal) * tangent_normal);
}

fn ink_tangent_frame(normal: vec3f) -> mat3x3f {
  let axis = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(normal.x) > 0.8);
  let tangent = normalize(cross(axis, normal));
  return mat3x3f(tangent, cross(normal, tangent), normal);
}

fn ink_surface_brdf(
  normal: vec3f,
  view_direction: vec3f,
  light_direction: vec3f,
  material: InkPackedMaterial,
  base_color: vec3f,
) -> vec3f {
  let normal_dot_light = max(dot(normal, light_direction), 0.0);
  let normal_dot_view = max(dot(normal, view_direction), 0.0);
  if (normal_dot_light <= 0.0 || normal_dot_view <= 0.0) {
    return vec3f(0.0);
  }
  let half_vector = normalize(view_direction + light_direction);
  let normal_dot_half = max(dot(normal, half_vector), 0.0);
  let view_dot_half = max(dot(view_direction, half_vector), 0.0);
  let roughness = clamp(material.emissive_roughness.w, 0.04, 1.0);
  let alpha = roughness * roughness;
  let distribution = ink_ray_ggx_distribution(normal_dot_half, alpha);
  let geometry_k = (roughness + 1.0) * (roughness + 1.0) * 0.125;
  let geometry_view = normal_dot_view / mix(normal_dot_view, 1.0, geometry_k);
  let geometry_light = normal_dot_light / mix(normal_dot_light, 1.0, geometry_k);
  let fresnel = material.specular_emissive_strength.rgb +
    (vec3f(1.0) - material.specular_emissive_strength.rgb) * pow(1.0 - view_dot_half, 5.0);
  let specular = distribution * geometry_view * geometry_light * fresnel /
    max(4.0 * normal_dot_view * normal_dot_light, 0.000001);
  let diffuse = base_color * (1.0 - material.base_color_metallic.w) / 3.14159265359;
  return (diffuse + specular) * normal_dot_light;
}

fn ink_direct_lighting(
  position: vec3f,
  normal: vec3f,
  view_direction: vec3f,
  material: InkPackedMaterial,
  base_color: vec3f,
  seed: ptr<function, u32>,
) -> vec3f {
  var radiance = vec3f(0.0);
  for (var light_index = 0u; light_index < path.counts.y; light_index += 1u) {
    let light = ink_light(light_index);
    let light_type = u32(light.direction_type.w);
    if (light_type == 4u) {
      radiance += light.color_intensity.rgb * light.color_intensity.w;
      continue;
    }
    var sample = InkRayTracingDirectLightSample(
      vec3f(0.0),
      1000000.0,
      vec3f(0.0),
      1.0,
    );
    if (light_type == 0u) {
      sample = InkRayTracingDirectLightSample(
        normalize(-light.direction_type.xyz),
        1000000.0,
        light.color_intensity.rgb * light.color_intensity.w / 10000.0,
        1.0,
      );
    } else if (light_type == 3u) {
      sample = ink_ray_sample_rectangular_light(
        position,
        light.position_range.xyz,
        light.direction_type.xyz,
        light.tangent_source.xyz,
        light.shape.xy,
        light.color_intensity.rgb * light.color_intensity.w,
        light.tangent_source.w > 0.5,
        vec2f(ink_random(seed), ink_random(seed)),
      );
    } else {
      sample = ink_ray_sample_point_light(
        position,
        light.position_range.xyz,
        light.color_intensity.rgb * light.color_intensity.w,
      );
    }
    var sample_radiance = sample.radiance;
    if (light.position_range.w > 0.0 && light_type != 0u) {
      let range_falloff = clamp(
        1.0 - sample.distance / light.position_range.w,
        0.0,
        1.0,
      );
      sample_radiance *= range_falloff * range_falloff;
    }
    if (light_type == 2u) {
      let cone_alignment = dot(
        -sample.direction,
        normalize(light.direction_type.xyz),
      );
      sample_radiance *= smoothstep(
        cos(light.shape.y),
        cos(light.shape.x),
        cone_alignment,
      );
    }
    let brdf = ink_surface_brdf(
      normal,
      view_direction,
      sample.direction,
      material,
      base_color,
    );
    if (all(brdf == vec3f(0.0)) || all(sample_radiance == vec3f(0.0))) {
      continue;
    }
    let shadow = ink_trace_scene(InkRayTracingRay(
      position + normal * 0.001,
      0.001,
      sample.direction,
      sample.distance - 0.002,
    ));
    if (shadow.hit == 0u) {
      radiance += brdf * sample_radiance / max(sample.probability_density, 0.000001);
    }
  }
  return radiance;
}

fn ink_trace_path(primary: InkRayTracingRay, seed_value: u32) -> vec4f {
  var ray = primary;
  var seed = seed_value;
  var throughput = vec3f(1.0);
  var radiance = vec3f(0.0);
  var primary_depth = 1000000.0;
  var primary_normal = vec3f(0.0, 0.0, 1.0);
  for (var bounce = 0u; bounce < path.dimensions.w; bounce += 1u) {
    let hit = ink_trace_scene(ray);
    if (hit.hit == 0u) {
      radiance += throughput * (path.clear_color.rgb + path.ambient_fog_density.rgb);
      break;
    }
    let position = ray.origin + ray.direction * hit.distance;
    let material = ink_material(triangles[hit.triangle_index].material_index);
    var normal = ink_surface_normal(hit, material);
    if (dot(normal, ray.direction) > 0.0) {
      normal = -normal;
    }
    if (bounce == 0u) {
      primary_depth = hit.distance;
      primary_normal = normal;
    }
    let base_color = ink_base_color(hit, material);
    radiance += throughput * material.emissive_roughness.rgb * material.specular_emissive_strength.w;
    radiance += throughput * ink_direct_lighting(
      position,
      normal,
      -ray.direction,
      material,
      base_color,
      &seed,
    );

    let metallic = clamp(material.base_color_metallic.w, 0.0, 1.0);
    let specular = material.specular_emissive_strength.rgb;
    if (metallic >= 0.999 && material.emissive_roughness.w <= 0.02) {
      throughput *= specular;
      ray = InkRayTracingRay(
        position + normal * 0.001,
        0.001,
        reflect(ray.direction, normal),
        1000000.0,
      );
      continue;
    }
    let roughness = clamp(material.emissive_roughness.w, 0.04, 1.0);
    let frame = ink_tangent_frame(normal);
    let random_sample = vec2f(ink_random(&seed), ink_random(&seed));
    let diffuse_direction = normalize(frame * vec3f(
      cos(6.28318530718 * random_sample.x) * sqrt(random_sample.y),
      sin(6.28318530718 * random_sample.x) * sqrt(random_sample.y),
      sqrt(1.0 - random_sample.y),
    ));
    let half_vector = normalize(frame * ink_ray_ggx_sample_half_vector(random_sample, roughness * roughness));
    let reflected = reflect(ray.direction, half_vector);
    let choose_specular = ink_random(&seed) < mix(0.08, 0.9, metallic);
    let next_direction = select(diffuse_direction, reflected, choose_specular && dot(reflected, normal) > 0.0);
    throughput *= select(base_color, specular, choose_specular);
    ray = InkRayTracingRay(position + normal * 0.001, 0.001, next_direction, 1000000.0);
  }
  let fog_amount = 1.0 - exp(-path.ambient_fog_density.w * path.ambient_fog_density.w * primary_depth * primary_depth);
  radiance = mix(radiance, path.fog_color.rgb, clamp(fog_amount, 0.0, 1.0));
  return vec4f(radiance, primary_depth);
}

fn ink_camera_ray(pixel: vec2u, jitter: vec2f) -> InkRayTracingRay {
  let uv = (vec2f(pixel) + vec2f(0.5) + jitter) / vec2f(path.dimensions.xy);
  let clip = vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 1.0, 1.0);
  let homogeneous = path.inverse_view_projection * clip;
  let world_position = homogeneous.xyz / homogeneous.w;
  return InkRayTracingRay(
    path.camera_position.xyz,
    0.001,
    normalize(world_position - path.camera_position.xyz),
    1000000.0,
  );
}

@compute @workgroup_size(8, 8)
fn path_trace_main(@builtin(global_invocation_id) invocation: vec3u) {
  let pixel = invocation.xy;
  if (any(pixel >= path.dimensions.xy)) {
    return;
  }
  let history = textureLoad(accumulation_history, vec2i(pixel), 0).rgb;
  let previous_moments = textureLoad(moments_history, vec2i(pixel), 0).rg;
  var accumulated = history;
  var moments = previous_moments;
  var depth = 1000000.0;
  var normal = vec3f(0.0, 0.0, 1.0);
  for (var sample = 0u; sample < path.dimensions.z; sample += 1u) {
    var jitter_seed = ink_hash(
      pixel.x + pixel.y * path.dimensions.x +
      (path.sequence.x + sample) * 0x85ebca6bu,
    );
    let jitter = vec2f(
      ink_random(&jitter_seed) - 0.5,
      ink_random(&jitter_seed) - 0.5,
    );
    let seed = ink_hash(
      pixel.x + pixel.y * path.dimensions.x +
      (path.sequence.x + sample) * 0x9e3779b9u,
    );
    let traced = ink_trace_path(ink_camera_ray(pixel, jitter), seed);
    accumulated = ink_ray_progressive_accumulation(
      accumulated,
      traced.rgb,
      path.counts.w + sample,
    );
    let luminance = dot(traced.rgb, vec3f(0.299, 0.587, 0.114));
    moments = ink_ray_update_moments(moments, luminance, path.counts.w + sample);
    depth = min(depth, traced.w);
  }
  let primary = ink_trace_scene(ink_camera_ray(pixel, vec2f(0.0)));
  if (primary.hit == 1u) {
    depth = primary.distance;
    let primary_material = ink_material(triangles[primary.triangle_index].material_index);
    normal = ink_surface_normal(primary, primary_material);
  }
  textureStore(accumulation_output, vec2i(pixel), vec4f(accumulated, 1.0));
  textureStore(depth_output, vec2i(pixel), vec4f(depth, 0.0, 0.0, 0.0));
  textureStore(normal_output, vec2i(pixel), vec4f(normal * 0.5 + 0.5, 1.0));
  textureStore(moments_output, vec2i(pixel), vec4f(moments, 0.0, 0.0));
}`,
  dependencies: [
    {
      module: ray_intersection_wgsl.id,
      symbols: [
        "InkRayTracingRay",
        "ink_ray_bounds_distance",
        "ink_ray_triangle_intersection",
      ],
    },
    {
      module: ray_stackless_traversal_wgsl.id,
      symbols: ["InkRayTracingBvhNode", "ink_ray_stackless_next"],
    },
    {
      module: ray_ggx_sampling_wgsl.id,
      symbols: [
        "ink_ray_ggx_distribution",
        "ink_ray_ggx_sample_half_vector",
      ],
    },
    {
      module: ray_direct_light_sampling_wgsl.id,
      symbols: [
        "InkRayTracingDirectLightSample",
        "ink_ray_sample_point_light",
        "ink_ray_sample_rectangular_light",
      ],
    },
    {
      module: ray_progressive_accumulation_wgsl.id,
      symbols: ["ink_ray_progressive_accumulation"],
    },
    {
      module: ray_variance_wgsl.id,
      symbols: ["ink_ray_update_moments"],
    },
  ],
  entry_points: [{ stage: "compute", name: "path_trace_main" }],
});

const path_denoise_module = create_wgsl_module({
  id: shader_module_id("ink/rendering/path-denoise"),
  revision: 0,
  source: `
struct InkDenoiseUniform {
  source_target_dimensions: vec4u,
}

@group(0) @binding(0) var<uniform> denoise: InkDenoiseUniform;
@group(0) @binding(1) var accumulation: texture_2d<f32>;
@group(0) @binding(2) var depth: texture_2d<f32>;
@group(0) @binding(3) var normal: texture_2d<f32>;
@group(0) @binding(4) var moments: texture_2d<f32>;
@group(0) @binding(5) var hdr_output: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn path_denoise_main(@builtin(global_invocation_id) invocation: vec3u) {
  let target_pixel = invocation.xy;
  if (any(target_pixel >= denoise.source_target_dimensions.zw)) {
    return;
  }
  let source_dimensions = denoise.source_target_dimensions.xy;
  let source_pixel = min(
    vec2u(vec2f(target_pixel) * vec2f(source_dimensions) / vec2f(denoise.source_target_dimensions.zw)),
    source_dimensions - vec2u(1u),
  );
  let center_depth = textureLoad(depth, vec2i(source_pixel), 0).r;
  let center_normal = textureLoad(normal, vec2i(source_pixel), 0).rgb * 2.0 - 1.0;
  var color = vec3f(0.0);
  var weight_sum = 0.0;
  for (var y = -2; y <= 2; y += 1) {
    for (var x = -2; x <= 2; x += 1) {
      let sample_pixel = clamp(
        vec2i(source_pixel) + vec2i(x, y),
        vec2i(0),
        vec2i(source_dimensions) - vec2i(1),
      );
      let sample_depth = textureLoad(depth, sample_pixel, 0).r;
      let sample_normal = textureLoad(normal, sample_pixel, 0).rgb * 2.0 - 1.0;
      let sample_moments = textureLoad(moments, sample_pixel, 0).rg;
      let spatial_weight = exp(-f32(x * x + y * y) * 0.125);
      let edge_weight = ink_ray_edge_aware_weight(
        center_depth,
        sample_depth,
        center_normal,
        sample_normal,
        sample_moments.x,
        sample_moments.y,
      );
      let weight = max(spatial_weight * edge_weight, select(0.0, 1.0, x == 0 && y == 0));
      color += textureLoad(accumulation, sample_pixel, 0).rgb * weight;
      weight_sum += weight;
    }
  }
  textureStore(hdr_output, vec2i(target_pixel), vec4f(color / max(weight_sum, 0.0001), 1.0));
}`,
  dependencies: [{
    module: ray_edge_aware_denoise_wgsl.id,
    symbols: ["ink_ray_edge_aware_weight"],
  }],
  entry_points: [{ stage: "compute", name: "path_denoise_main" }],
});

export const path_trace_shader = compose_wgsl_modules(
  [path_trace_module.id],
  [...ray_tracing_wgsl_modules, path_trace_module],
);

export const path_denoise_shader = compose_wgsl_modules(
  [path_denoise_module.id],
  [...ray_tracing_wgsl_modules, path_denoise_module],
);
