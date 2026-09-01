import { compose_wgsl_modules } from "@ink/shaders/compose.ts";
import { shader_module_id } from "@ink/shaders/identity.ts";
import { create_wgsl_module } from "@ink/shaders/module.ts";
import { brdf_wgsl, pbr_wgsl } from "@ink/shaders/pbr.ts";

const raster_scene_source = `
const POINT_LIGHT_COUNT = 4u;
const SPOT_LIGHT_COUNT = 2u;

struct FrameUniform {
  view_projection: mat4x4f,
  light_view_projection: mat4x4f,
  camera_exposure: vec4f,
  ambient_fog: vec4f,
  fog_color_bloom_threshold: vec4f,
  directional_direction_intensity: vec4f,
  directional_color: vec4f,
  point_positions: array<vec4f, 4>,
  point_colors: array<vec4f, 4>,
  spot_positions: array<vec4f, 2>,
  spot_directions: array<vec4f, 2>,
  spot_colors: array<vec4f, 2>,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) world_position: vec3f,
  @location(1) normal: vec3f,
  @location(2) albedo_roughness: vec4f,
  @location(3) emissive_metallic: vec4f,
  @location(4) shadow_position: vec4f,
  @location(5) uv: vec2f,
}

@group(0) @binding(0) var<uniform> frame: FrameUniform;
@group(0) @binding(1) var shadow_map: texture_depth_2d;
@group(0) @binding(2) var shadow_sampler: sampler_comparison;
@group(1) @binding(0) var base_color_texture: texture_2d<f32>;
@group(1) @binding(1) var base_color_sampler: sampler;
@group(1) @binding(2) var normal_texture: texture_2d<f32>;
@group(1) @binding(3) var normal_sampler: sampler;

@vertex fn vertex_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) model_0: vec4f,
  @location(3) model_1: vec4f,
  @location(4) model_2: vec4f,
  @location(5) model_3: vec4f,
  @location(6) albedo_roughness: vec4f,
  @location(7) emissive_metallic: vec4f,
  @location(8) uv: vec2f,
) -> VertexOutput {
  let model = mat4x4f(model_0, model_1, model_2, model_3);
  let world = model * vec4f(position, 1.0);
  let normal_matrix = mat3x3f(
    model_0.xyz / max(dot(model_0.xyz, model_0.xyz), 0.000001),
    model_1.xyz / max(dot(model_1.xyz, model_1.xyz), 0.000001),
    model_2.xyz / max(dot(model_2.xyz, model_2.xyz), 0.000001),
  );
  var output: VertexOutput;
  output.position = frame.view_projection * world;
  output.world_position = world.xyz;
  output.normal = normalize(normal_matrix * normal);
  output.albedo_roughness = albedo_roughness;
  output.emissive_metallic = emissive_metallic;
  output.shadow_position = frame.light_view_projection * world;
  output.uv = uv;
  return output;
}

fn shadow_visibility(position: vec4f, normal: vec3f) -> f32 {
  let projected = position.xyz / position.w;
  let uv = projected.xy * vec2f(0.5, -0.5) + vec2f(0.5);
  if (projected.z <= 0.0 || projected.z >= 1.0 || any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) {
    return 1.0;
  }
  let dimensions = vec2f(textureDimensions(shadow_map));
  let texel = 1.0 / dimensions;
  let facing = max(dot(normal, normalize(-frame.directional_direction_intensity.xyz)), 0.0);
  let bias = mix(0.0025, 0.00035, facing);
  var visibility = 0.0;
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      visibility += textureSampleCompareLevel(
        shadow_map,
        shadow_sampler,
        uv + vec2f(f32(x), f32(y)) * texel,
        projected.z - bias,
      );
    }
  }
  return visibility / 9.0;
}

fn material_light(
  normal: vec3f,
  view_direction: vec3f,
  light_direction: vec3f,
  light_color: vec3f,
  intensity: f32,
  albedo: vec3f,
  roughness: f32,
  metallic: f32,
) -> vec3f {
  let incoming = normalize(light_direction);
  let specular_f0 = mix(vec3f(0.04), albedo, metallic);
  return ink_evaluate_pbr(
    albedo,
    metallic,
    roughness,
    specular_f0,
    normal,
    view_direction,
    incoming,
  ) * light_color * intensity;
}

fn material_normal(input: VertexOutput) -> vec3f {
  let geometric = normalize(input.normal);
  let sampled = textureSampleBias(
    normal_texture,
    normal_sampler,
    input.uv,
    0.75,
  ).xyz * 2.0 - 1.0;
  let position_x = dpdx(input.world_position);
  let position_y = dpdy(input.world_position);
  let uv_x = dpdx(input.uv);
  let uv_y = dpdy(input.uv);
  let determinant = uv_x.x * uv_y.y - uv_x.y * uv_y.x;
  if (abs(determinant) < 0.000001 || length(sampled.xy) < 0.01) {
    return geometric;
  }
  var tangent = normalize((position_x * uv_y.y - position_y * uv_x.y) / determinant);
  tangent = normalize(tangent - geometric * dot(geometric, tangent));
  let handedness = select(-1.0, 1.0, determinant >= 0.0);
  let bitangent = normalize(cross(geometric, tangent)) * handedness;
  return normalize(tangent * sampled.x + bitangent * sampled.y + geometric * sampled.z);
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let normal = material_normal(input);
  let view_direction = normalize(frame.camera_exposure.xyz - input.world_position);
  let base_color = textureSampleBias(
    base_color_texture,
    base_color_sampler,
    input.uv,
    0.35,
  );
  if (base_color.a < 0.5) {
    discard;
  }
  let albedo = input.albedo_roughness.rgb * base_color.rgb;
  let authored_roughness = clamp(input.albedo_roughness.a, 0.04, 1.0);
  let normal_variance = dot(dpdx(normal), dpdx(normal)) +
    dot(dpdy(normal), dpdy(normal));
  let roughness = clamp(
    sqrt(authored_roughness * authored_roughness + min(normal_variance * 0.25, 1.0)),
    0.04,
    1.0,
  );
  let metallic = clamp(input.emissive_metallic.a, 0.0, 1.0);
  var color = albedo * frame.ambient_fog.rgb;

  let directional = material_light(
    normal,
    view_direction,
    normalize(-frame.directional_direction_intensity.xyz),
    frame.directional_color.rgb,
    frame.directional_direction_intensity.w,
    albedo,
    roughness,
    metallic,
  );
  color += directional * shadow_visibility(input.shadow_position, normal);

  for (var index = 0u; index < POINT_LIGHT_COUNT; index += 1u) {
    if (frame.point_colors[index].w <= 0.0 || frame.point_positions[index].w <= 0.0) {
      continue;
    }
    let offset = frame.point_positions[index].xyz - input.world_position;
    let distance = length(offset);
    let range = frame.point_positions[index].w;
    let falloff = pow(clamp(1.0 - distance / max(range, 0.001), 0.0, 1.0), 2.0);
    color += material_light(
      normal,
      view_direction,
      offset,
      frame.point_colors[index].rgb,
      frame.point_colors[index].w * falloff,
      albedo,
      roughness,
      metallic,
    );
  }

  for (var index = 0u; index < SPOT_LIGHT_COUNT; index += 1u) {
    if (frame.spot_colors[index].w <= 0.0 || frame.spot_positions[index].w <= 0.0) {
      continue;
    }
    let offset = frame.spot_positions[index].xyz - input.world_position;
    let distance = length(offset);
    let range = frame.spot_positions[index].w;
    let light_to_surface = normalize(-offset);
    let cone = smoothstep(
      frame.spot_directions[index].w,
      min(1.0, frame.spot_directions[index].w + 0.12),
      dot(light_to_surface, normalize(frame.spot_directions[index].xyz)),
    );
    let falloff = pow(clamp(1.0 - distance / max(range, 0.001), 0.0, 1.0), 2.0);
    color += material_light(
      normal,
      view_direction,
      offset,
      frame.spot_colors[index].rgb,
      frame.spot_colors[index].w * cone * falloff,
      albedo,
      roughness,
      metallic,
    );
  }

  color += input.emissive_metallic.rgb;
  let distance = length(frame.camera_exposure.xyz - input.world_position);
  let fog_amount = 1.0 - exp(-frame.ambient_fog.w * frame.ambient_fog.w * distance * distance);
  return vec4f(mix(color, frame.fog_color_bloom_threshold.rgb, clamp(fog_amount, 0.0, 1.0)), 1.0);
}
`;

const raster_shadow_source = `
struct ShadowUniform {
  light_view_projection: mat4x4f,
}

@group(0) @binding(0) var<uniform> shadow: ShadowUniform;

@vertex fn vertex_main(
  @location(0) position: vec3f,
  @location(2) model_0: vec4f,
  @location(3) model_1: vec4f,
  @location(4) model_2: vec4f,
  @location(5) model_3: vec4f,
) -> @builtin(position) vec4f {
  let model = mat4x4f(model_0, model_1, model_2, model_3);
  return shadow.light_view_projection * model * vec4f(position, 1.0);
}
`;

const raster_post_source = `
struct PostUniform {
  exposure_bloom: vec4f,
  texel_anti_aliasing: vec4f,
}

@group(0) @binding(0) var hdr_texture: texture_2d<f32>;
@group(0) @binding(1) var hdr_sampler: sampler;
@group(0) @binding(2) var<uniform> post: PostUniform;
@group(0) @binding(3) var agx_sdr_lut: texture_3d<f32>;
@group(0) @binding(4) var agx_hdr_lut: texture_3d<f32>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = positions[index] * vec2f(0.5, -0.5) + vec2f(0.5);
  return output;
}

fn agx_lut_texel(position: vec3i, hdr: bool) -> vec3f {
  if (hdr) {
    return textureLoad(agx_hdr_lut, position, 0).rgb;
  }
  return textureLoad(agx_sdr_lut, position, 0).rgb;
}

fn agx_lut_sample(encoded: vec3f, hdr: bool) -> vec3f {
  let maximum = vec3i(textureDimensions(agx_sdr_lut)) - vec3i(1);
  let coordinate = clamp(encoded, vec3f(0.0), vec3f(1.0)) * vec3f(maximum);
  let lower = vec3i(floor(coordinate));
  let upper = min(lower + vec3i(1), maximum);
  let fraction = fract(coordinate);
  let c000 = agx_lut_texel(lower, hdr);
  let c111 = agx_lut_texel(upper, hdr);
  if (fraction.x >= fraction.y) {
    if (fraction.y >= fraction.z) {
      let c100 = agx_lut_texel(vec3i(upper.x, lower.yz), hdr);
      let c110 = agx_lut_texel(vec3i(upper.xy, lower.z), hdr);
      return c000 + fraction.x * (c100 - c000) +
        fraction.y * (c110 - c100) + fraction.z * (c111 - c110);
    }
    if (fraction.x >= fraction.z) {
      let c100 = agx_lut_texel(vec3i(upper.x, lower.yz), hdr);
      let c101 = agx_lut_texel(vec3i(upper.x, lower.y, upper.z), hdr);
      return c000 + fraction.x * (c100 - c000) +
        fraction.z * (c101 - c100) + fraction.y * (c111 - c101);
    }
    let c001 = agx_lut_texel(vec3i(lower.xy, upper.z), hdr);
    let c101 = agx_lut_texel(vec3i(upper.x, lower.y, upper.z), hdr);
    return c000 + fraction.z * (c001 - c000) +
      fraction.x * (c101 - c001) + fraction.y * (c111 - c101);
  }
  if (fraction.x >= fraction.z) {
    let c010 = agx_lut_texel(vec3i(lower.x, upper.y, lower.z), hdr);
    let c110 = agx_lut_texel(vec3i(upper.xy, lower.z), hdr);
    return c000 + fraction.y * (c010 - c000) +
      fraction.x * (c110 - c010) + fraction.z * (c111 - c110);
  }
  if (fraction.y >= fraction.z) {
    let c010 = agx_lut_texel(vec3i(lower.x, upper.y, lower.z), hdr);
    let c011 = agx_lut_texel(vec3i(lower.x, upper.yz), hdr);
    return c000 + fraction.y * (c010 - c000) +
      fraction.z * (c011 - c010) + fraction.x * (c111 - c011);
  }
  let c001 = agx_lut_texel(vec3i(lower.xy, upper.z), hdr);
  let c011 = agx_lut_texel(vec3i(lower.x, upper.yz), hdr);
  return c000 + fraction.z * (c001 - c000) +
    fraction.y * (c011 - c001) + fraction.x * (c111 - c011);
}

fn linear_rec709_to_agx_log(color: vec3f) -> vec3f {
  let linear_egamut = mat3x3f(
    vec3f(0.55937113, 0.07622071, 0.06552670),
    vec3f(0.30478326, 0.78797183, 0.16454675),
    vec3f(0.13584556, 0.13580748, 0.76992653),
  ) * color;
  return clamp(
    (log2(max(linear_egamut, vec3f(0.0001757814))) + vec3f(12.47393)) /
      25.0,
    vec3f(0.0),
    vec3f(1.0),
  );
}

fn srgb_encode(color: vec3f) -> vec3f {
  let magnitude = abs(color);
  let encoded = select(
    magnitude * 12.92,
    1.055 * pow(magnitude, vec3f(1.0 / 2.4)) - vec3f(0.055),
    magnitude > vec3f(0.0031308),
  );
  return sign(color) * encoded;
}

fn inverse_hlg_oetf(encoded: vec3f) -> vec3f {
  let low = encoded * encoded / 3.0;
  let high = (exp((encoded - vec3f(0.55991073)) / 0.17883277) +
    vec3f(0.28466892)) / 12.0;
  return select(low, high, encoded > vec3f(0.5));
}

fn agx_sdr(color: vec3f) -> vec3f {
  let rec1886 = agx_lut_sample(linear_rec709_to_agx_log(color), false);
  return clamp(
    srgb_encode(pow(max(rec1886, vec3f(0.0)), vec3f(2.4))),
    vec3f(0.0),
    vec3f(1.0),
  );
}

fn agx_hdr(color: vec3f) -> vec3f {
  let hlg = agx_lut_sample(linear_rec709_to_agx_log(color), true);
  let scene_rec2020 = inverse_hlg_oetf(hlg);
  let scene_luminance = dot(scene_rec2020, vec3f(0.2627, 0.6780, 0.0593));
  let display_rec2020 = scene_rec2020 * pow(max(scene_luminance, 0.000001), 0.2) * 10.0;
  let display_rec709 = mat3x3f(
    vec3f(1.6604910, -0.1245505, -0.0181508),
    vec3f(-0.5876411, 1.1328999, -0.1005789),
    vec3f(-0.0728499, -0.0083494, 1.1187297),
  ) * display_rec2020;
  return srgb_encode(display_rec709);
}

fn luminance(color: vec3f) -> f32 {
  return dot(color, vec3f(0.299, 0.587, 0.114));
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let texel = post.texel_anti_aliasing.xy;
  let center = textureSample(hdr_texture, hdr_sampler, input.uv).rgb;
  let northwest = textureSample(
    hdr_texture,
    hdr_sampler,
    input.uv + vec2f(-1.0, -1.0) * texel,
  ).rgb;
  let northeast = textureSample(
    hdr_texture,
    hdr_sampler,
    input.uv + vec2f(1.0, -1.0) * texel,
  ).rgb;
  let southwest = textureSample(
    hdr_texture,
    hdr_sampler,
    input.uv + vec2f(-1.0, 1.0) * texel,
  ).rgb;
  let southeast = textureSample(
    hdr_texture,
    hdr_sampler,
    input.uv + vec2f(1.0, 1.0) * texel,
  ).rgb;
  let center_luminance = luminance(center);
  let minimum_luminance = min(
    center_luminance,
    min(
      min(luminance(northwest), luminance(northeast)),
      min(luminance(southwest), luminance(southeast)),
    ),
  );
  let maximum_luminance = max(
    center_luminance,
    max(
      max(luminance(northwest), luminance(northeast)),
      max(luminance(southwest), luminance(southeast)),
    ),
  );
  var edge_direction = vec2f(
    -((luminance(northwest) + luminance(northeast)) -
      (luminance(southwest) + luminance(southeast))),
    (luminance(northwest) + luminance(southwest)) -
      (luminance(northeast) + luminance(southeast)),
  );
  let direction_reduction = max(
    (luminance(northwest) + luminance(northeast) +
        luminance(southwest) + luminance(southeast)) * 0.03125,
    0.0078125,
  );
  let reciprocal_direction = 1.0 /
    (min(abs(edge_direction.x), abs(edge_direction.y)) + direction_reduction);
  edge_direction = clamp(
    edge_direction * reciprocal_direction,
    vec2f(-8.0),
    vec2f(8.0),
  ) * texel;
  let inner_edge = 0.5 * (
    textureSample(
      hdr_texture,
      hdr_sampler,
      input.uv + edge_direction * -0.16666667,
    ).rgb +
    textureSample(
      hdr_texture,
      hdr_sampler,
      input.uv + edge_direction * 0.16666667,
    ).rgb
  );
  let outer_edge = inner_edge * 0.5 + 0.25 * (
    textureSample(
      hdr_texture,
      hdr_sampler,
      input.uv + edge_direction * -0.5,
    ).rgb +
    textureSample(
      hdr_texture,
      hdr_sampler,
      input.uv + edge_direction * 0.5,
    ).rgb
  );
  let outer_luminance = luminance(outer_edge);
  let antialiased = select(
    outer_edge,
    inner_edge,
    outer_luminance < minimum_luminance || outer_luminance > maximum_luminance,
  );
  let source = select(
    center,
    antialiased,
    post.texel_anti_aliasing.z > 0.5,
  );
  var bloom = vec3f(0.0);
  var weight = 0.0;
  for (var y = -2; y <= 2; y += 1) {
    for (var x = -2; x <= 2; x += 1) {
      let sample_color = textureSample(
        hdr_texture,
        hdr_sampler,
        input.uv + vec2f(f32(x), f32(y)) * texel * 2.0,
      ).rgb;
      let brightness = max(sample_color.r, max(sample_color.g, sample_color.b));
      let contribution = smoothstep(1.0, 2.0, brightness);
      bloom += sample_color * contribution;
      weight += contribution;
    }
  }
  let combined = source + bloom / max(weight, 1.0) * post.exposure_bloom.y;
  let exposed = max(combined * exp2(post.exposure_bloom.x), vec3f(0.0));
  var display_color: vec3f;
  if (post.exposure_bloom.z > 0.5) {
    display_color = agx_hdr(exposed);
  } else {
    display_color = agx_sdr(exposed);
  }
  return vec4f(display_color, 1.0);
}
`;

const raster_temporal_source = `
struct TemporalUniform {
  history_weight_texel: vec4f,
}

@group(0) @binding(0) var current_texture: texture_2d<f32>;
@group(0) @binding(1) var history_texture: texture_2d<f32>;
@group(0) @binding(2) var temporal_sampler: sampler;
@group(0) @binding(3) var<uniform> temporal: TemporalUniform;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = positions[index] * vec2f(0.5, -0.5) + vec2f(0.5);
  return output;
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let texel = temporal.history_weight_texel.yz;
  let current = textureSample(current_texture, temporal_sampler, input.uv).rgb;
  var neighborhood_minimum = current;
  var neighborhood_maximum = current;
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let sample_color = textureSample(
        current_texture,
        temporal_sampler,
        input.uv + vec2f(f32(x), f32(y)) * texel,
      ).rgb;
      neighborhood_minimum = min(neighborhood_minimum, sample_color);
      neighborhood_maximum = max(neighborhood_maximum, sample_color);
    }
  }
  let history = textureSample(history_texture, temporal_sampler, input.uv).rgb;
  let clipped_history = clamp(history, neighborhood_minimum, neighborhood_maximum);
  let accumulated = mix(
    current,
    clipped_history,
    temporal.history_weight_texel.x,
  );
  return vec4f(accumulated, 1.0);
}
`;

const raster_mipmap_source = `
@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = positions[index] * vec2f(0.5, -0.5) + vec2f(0.5);
  return output;
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  return textureSampleLevel(source_texture, source_sampler, input.uv, 0.0);
}
`;

const raster_scene_module = create_wgsl_module({
  id: shader_module_id("ink/rendering/raster-scene"),
  revision: 1,
  dependencies: [{
    module: pbr_wgsl.id,
    symbols: ["ink_evaluate_pbr"],
  }],
  source: raster_scene_source,
  entry_points: [
    { stage: "vertex", name: "vertex_main" },
    { stage: "fragment", name: "fragment_main" },
  ],
});

const raster_shadow_module = create_wgsl_module({
  id: shader_module_id("ink/rendering/raster-shadow"),
  revision: 0,
  source: raster_shadow_source,
  entry_points: [{ stage: "vertex", name: "vertex_main" }],
});

const raster_post_module = create_wgsl_module({
  id: shader_module_id("ink/rendering/raster-post"),
  revision: 0,
  source: raster_post_source,
  entry_points: [
    { stage: "vertex", name: "vertex_main" },
    { stage: "fragment", name: "fragment_main" },
  ],
});

const raster_temporal_module = create_wgsl_module({
  id: shader_module_id("ink/rendering/raster-temporal"),
  revision: 0,
  source: raster_temporal_source,
  entry_points: [
    { stage: "vertex", name: "vertex_main" },
    { stage: "fragment", name: "fragment_main" },
  ],
});

const raster_mipmap_module = create_wgsl_module({
  id: shader_module_id("ink/rendering/raster-mipmap"),
  revision: 0,
  source: raster_mipmap_source,
  entry_points: [
    { stage: "vertex", name: "vertex_main" },
    { stage: "fragment", name: "fragment_main" },
  ],
});

export const raster_scene_shader = compose_wgsl_modules(
  [raster_scene_module.id],
  [raster_scene_module, pbr_wgsl, brdf_wgsl],
);
export const raster_shadow_shader = compose_wgsl_modules(
  [raster_shadow_module.id],
  [raster_shadow_module],
);
export const raster_post_shader = compose_wgsl_modules(
  [raster_post_module.id],
  [raster_post_module],
);
export const raster_temporal_shader = compose_wgsl_modules(
  [raster_temporal_module.id],
  [raster_temporal_module],
);
export const raster_mipmap_shader = compose_wgsl_modules(
  [raster_mipmap_module.id],
  [raster_mipmap_module],
);
