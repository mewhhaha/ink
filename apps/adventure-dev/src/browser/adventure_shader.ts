import { surface_shader_source } from "@ink/rendering/compatibility_renderer.ts";

export const adventure_shader_source = `
${surface_shader_source}

struct FrameUniform {
  view_projection: mat4x4f,
  light_direction: vec4f,
  light_colour: vec4f,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world_position: vec3f,
  @location(2) local_position: vec3f,
  @location(3) color_and_emissive: vec4f,
  @location(4) texture_scale: vec4f,
  @location(5) blend_parameters: vec4f,
}

@group(0) @binding(0) var<uniform> frame_uniform: FrameUniform;
@group(0) @binding(1) var model_texture: texture_2d<f32>;
@group(0) @binding(2) var secondary_model_texture: texture_2d<f32>;
@group(0) @binding(3) var model_sampler: sampler;

@vertex fn vertex_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) model_0: vec4f,
  @location(3) model_1: vec4f,
  @location(4) model_2: vec4f,
  @location(5) model_3: vec4f,
  @location(6) color_and_emissive: vec4f,
  @location(7) texture_scale: vec4f,
  @location(8) blend_parameters: vec4f,
) -> VertexOutput {
  let model = mat4x4f(model_0, model_1, model_2, model_3);
  let world_position = model * vec4f(position, 1.0);
  let normal_matrix = mat3x3f(
    normalize(model[0].xyz),
    normalize(model[1].xyz),
    normalize(model[2].xyz),
  );
  var output: VertexOutput;
  output.position = frame_uniform.view_projection * world_position;
  output.normal = normalize(normal_matrix * normal);
  output.world_position = world_position.xyz;
  output.local_position = position;
  output.color_and_emissive = color_and_emissive;
  output.texture_scale = texture_scale;
  output.blend_parameters = blend_parameters;
  return output;
}

fn ink_random(point: vec2f, seed: f32) -> f32 {
  return fract(sin(dot(point, vec2f(127.1, 311.7)) + seed) * 43758.5453);
}

fn ink_value_noise(position: vec2f, seed: f32) -> f32 {
  let cell = floor(position);
  let fraction = fract(position);
  let smooth_fraction = fraction * fraction * (vec2f(3.0) - 2.0 * fraction);
  let top = mix(
    ink_random(cell, seed),
    ink_random(cell + vec2f(1.0, 0.0), seed),
    smooth_fraction.x,
  );
  let bottom = mix(
    ink_random(cell + vec2f(0.0, 1.0), seed),
    ink_random(cell + vec2f(1.0, 1.0), seed),
    smooth_fraction.x,
  );
  return mix(top, bottom, smooth_fraction.y);
}

fn ink_terrain_blend(input: VertexOutput) -> f32 {
  let northeast_edge = 1u;
  let southwest_edge = 2u;
  let northwest_edge = 4u;
  let southeast_edge = 8u;
  let north_corner = 16u;
  let south_corner = 32u;
  let west_corner = 64u;
  let east_corner = 128u;
  let edges = u32(input.blend_parameters.x);
  let northeast_proximity =
    input.local_position.x / 0.9 + input.local_position.y / 0.45;
  let southwest_proximity =
    -input.local_position.x / 0.9 - input.local_position.y / 0.45;
  let northwest_proximity =
    -input.local_position.x / 0.9 + input.local_position.y / 0.45;
  let southeast_proximity =
    input.local_position.x / 0.9 - input.local_position.y / 0.45;
  var proximity = -2.0;
  if ((edges & northeast_edge) != 0u) {
    proximity = max(proximity, northeast_proximity);
  }
  if ((edges & southwest_edge) != 0u) {
    proximity = max(proximity, southwest_proximity);
  }
  if ((edges & northwest_edge) != 0u) {
    proximity = max(proximity, northwest_proximity);
  }
  if ((edges & southeast_edge) != 0u) {
    proximity = max(proximity, southeast_proximity);
  }
  if ((edges & north_corner) != 0u) {
    proximity = max(
      proximity,
      min(northeast_proximity, northwest_proximity),
    );
  }
  if ((edges & south_corner) != 0u) {
    proximity = max(
      proximity,
      min(southwest_proximity, southeast_proximity),
    );
  }
  if ((edges & west_corner) != 0u) {
    proximity = max(
      proximity,
      min(southwest_proximity, northwest_proximity),
    );
  }
  if ((edges & east_corner) != 0u) {
    proximity = max(
      proximity,
      min(northeast_proximity, southeast_proximity),
    );
  }
  let noise = ink_value_noise(
    input.world_position.xy * 6.0,
    input.blend_parameters.y,
  ) * 2.0 - 1.0;
  return smoothstep(0.58, 0.88, proximity + noise * 0.12);
}

fn ink_logical_square(local_position: vec3f) -> vec2f {
  return vec2f(
    local_position.x / 1.8 + local_position.y / 0.9,
    -local_position.x / 1.8 + local_position.y / 0.9,
  );
}

fn ink_upright_decal_uv(local_position: vec3f) -> vec2f {
  return vec2f(
    local_position.x + 0.5,
    0.5 - local_position.y,
  );
}

struct TriplanarProjection {
  x_uv: vec2f,
  y_uv: vec2f,
  z_uv: vec2f,
  x_uv_dx: vec2f,
  x_uv_dy: vec2f,
  y_uv_dx: vec2f,
  y_uv_dy: vec2f,
  z_uv_dx: vec2f,
  z_uv_dy: vec2f,
  weights: vec3f,
}

fn ink_triplanar_projection(
  world_position: vec3f,
  world_normal: vec3f,
  texture_scale: vec2f,
) -> TriplanarProjection {
  let x_uv = world_position.zy * texture_scale;
  let y_uv = world_position.xz * texture_scale;
  let z_uv = world_position.xy * texture_scale;
  let unnormalized_weights = pow(abs(normalize(world_normal)), vec3f(4.0));
  let weights = unnormalized_weights / max(
    dot(unnormalized_weights, vec3f(1.0)),
    0.0001,
  );
  return TriplanarProjection(
    x_uv,
    y_uv,
    z_uv,
    dpdx(x_uv),
    dpdy(x_uv),
    dpdx(y_uv),
    dpdy(y_uv),
    dpdx(z_uv),
    dpdy(z_uv),
    weights,
  );
}

fn ink_sample_triplanar(
  surface_texture: texture_2d<f32>,
  surface_sampler: sampler,
  projection: TriplanarProjection,
) -> vec4f {
  let x_color = textureSampleGrad(
    surface_texture,
    surface_sampler,
    projection.x_uv,
    projection.x_uv_dx,
    projection.x_uv_dy,
  );
  let y_color = textureSampleGrad(
    surface_texture,
    surface_sampler,
    projection.y_uv,
    projection.y_uv_dx,
    projection.y_uv_dy,
  );
  let z_color = textureSampleGrad(
    surface_texture,
    surface_sampler,
    projection.z_uv,
    projection.z_uv_dx,
    projection.z_uv_dy,
  );
  return x_color * projection.weights.x
    + y_color * projection.weights.y
    + z_color * projection.weights.z;
}

fn ink_capsule_distance(
  point: vec2f,
  start: vec2f,
  end: vec2f,
  radius: f32,
) -> f32 {
  let offset = point - start;
  let segment = end - start;
  let amount = clamp(dot(offset, segment) / dot(segment, segment), 0.0, 1.0);
  return length(offset - segment * amount) - radius;
}

fn ink_connected_path_distance(point: vec2f, connections: u32) -> f32 {
  let northeast = 1u;
  let southwest = 2u;
  let northwest = 4u;
  let southeast = 8u;
  let center = vec2f(0.0);
  let radius = 0.075;
  var distance = length(point) - radius;
  if ((connections & northeast) != 0u) {
    distance = min(
      distance,
      ink_capsule_distance(point, center, vec2f(0.56, 0.0), radius),
    );
  }
  if ((connections & southwest) != 0u) {
    distance = min(
      distance,
      ink_capsule_distance(point, center, vec2f(-0.56, 0.0), radius),
    );
  }
  if ((connections & northwest) != 0u) {
    distance = min(
      distance,
      ink_capsule_distance(point, center, vec2f(0.0, 0.56), radius),
    );
  }
  if ((connections & southeast) != 0u) {
    distance = min(
      distance,
      ink_capsule_distance(point, center, vec2f(0.0, -0.56), radius),
    );
  }
  return distance;
}

fn ink_preview_illumination(
  normal: vec3f,
  world_position: vec3f,
  light_direction: vec3f,
  light_color: vec3f,
  light_intensity: f32,
) -> vec3f {
  let surface_normal = normalize(normal);
  let incoming_light = normalize(-light_direction);
  let view_direction = normalize(vec3f(0.0, 0.0, 6.0) - world_position);
  let half_direction = normalize(incoming_light + view_direction);
  let diffuse = max(dot(surface_normal, incoming_light), 0.0);
  let wrapped_diffuse = max((diffuse + 0.12) / 1.12, 0.0);
  let sky_amount = surface_normal.y * 0.5 + 0.5;
  let ambient = mix(
    vec3f(0.055, 0.04, 0.03),
    vec3f(0.17, 0.23, 0.34),
    sky_amount,
  );
  let view_fresnel = pow(
    1.0 - max(dot(surface_normal, view_direction), 0.0),
    5.0,
  );
  let specular = pow(
    max(dot(surface_normal, half_direction), 0.0),
    48.0,
  ) * (0.04 + 0.16 * view_fresnel);
  let rim = pow(
    1.0 - max(dot(surface_normal, view_direction), 0.0),
    3.0,
  ) * 0.06;
  return ambient
    + light_color * light_intensity * (wrapped_diffuse * 0.82 + specular)
    + light_color * rim;
}

fn ink_aces_tone_map(color: vec3f) -> vec3f {
  let numerator = color * (2.51 * color + vec3f(0.03));
  let denominator = color * (2.43 * color + vec3f(0.59)) + vec3f(0.14);
  return clamp(numerator / denominator, vec3f(0.0), vec3f(1.0));
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let world_uv = input.world_position.xy * input.texture_scale.xy;
  let local_uv = input.local_position.xy * input.texture_scale.xy;
  let triplanar_projection = ink_triplanar_projection(
    input.world_position,
    input.normal,
    input.texture_scale.xy,
  );
  let logical_position = ink_logical_square(input.local_position);
  let upright_decal_position = clamp(
    ink_upright_decal_uv(input.local_position),
    vec2f(0.0),
    vec2f(0.999999),
  );
  let upright_decal_uv = upright_decal_position * input.texture_scale.xy
    + input.texture_scale.zw;
  let world_uv_dx = dpdx(world_uv);
  let world_uv_dy = dpdy(world_uv);
  let local_uv_dx = dpdx(local_uv);
  let local_uv_dy = dpdy(local_uv);
  let upright_decal_uv_dx = dpdx(upright_decal_uv);
  let upright_decal_uv_dy = dpdy(upright_decal_uv);
  let surface_mode = u32(input.blend_parameters.z);
  var texture_color = textureSampleGrad(
    model_texture,
    model_sampler,
    world_uv,
    world_uv_dx,
    world_uv_dy,
  );
  if (surface_mode == 0u) {
    texture_color = ink_sample_triplanar(
      model_texture,
      model_sampler,
      triplanar_projection,
    );
    let secondary_color = ink_sample_triplanar(
      secondary_model_texture,
      model_sampler,
      triplanar_projection,
    );
    texture_color = mix(
      texture_color,
      secondary_color,
      ink_terrain_blend(input),
    );
  }
  let path_distance = ink_connected_path_distance(
    logical_position,
    u32(input.blend_parameters.w),
  );
  let path_antialias = max(fwidth(path_distance) * 1.5, 0.002);
  if (surface_mode == 1u) {
    texture_color.a *= 1.0 - smoothstep(
      -path_antialias,
      path_antialias,
      path_distance,
    );
  }
  if (surface_mode == 2u) {
    texture_color = textureSampleGrad(
      model_texture,
      model_sampler,
      upright_decal_uv,
      upright_decal_uv_dx,
      upright_decal_uv_dy,
    );
  }
  if (surface_mode == 3u) {
    texture_color = textureSampleGrad(
      model_texture,
      model_sampler,
      local_uv,
      local_uv_dx,
      local_uv_dy,
    );
  }
  if (surface_mode == 4u) {
    let texture_size = vec2f(textureDimensions(model_texture));
    let pixel_center = (floor(upright_decal_uv * texture_size) + 0.5)
      / texture_size;
    texture_color = textureSampleLevel(
      model_texture,
      model_sampler,
      pixel_center,
      0.0,
    );
  }
  if (texture_color.a <= 0.01) {
    discard;
  }
  let color = ink_srgb_to_linear(
    input.color_and_emissive.rgb * texture_color.rgb,
  );
  let lighting = ink_preview_illumination(
    input.normal,
    input.world_position,
    frame_uniform.light_direction.xyz,
    frame_uniform.light_colour.rgb,
    frame_uniform.light_colour.a,
  );
  let lit_color = color * (lighting + vec3f(input.color_and_emissive.a));
  let camera_distance = length(vec3f(0.0, 0.0, 6.0) - input.world_position);
  let fog_amount = smoothstep(8.0, 18.0, camera_distance) * 0.42;
  let fogged_color = mix(lit_color, vec3f(0.012, 0.018, 0.035), fog_amount);
  return vec4f(
    ink_linear_to_srgb(ink_aces_tone_map(fogged_color * 1.15)),
    texture_color.a,
  );
}
`;
