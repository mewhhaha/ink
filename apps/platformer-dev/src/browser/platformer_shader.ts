import { surface_shader_source } from "@ink/rendering/compatibility_renderer.ts";

export const platformer_shader_source = `
${surface_shader_source}

struct FrameUniform {
  view_projection: mat4x4f,
  light_direction: vec4f,
  light_colour: vec4f,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) local_position: vec3f,
  @location(2) color_and_emissive: vec4f,
  @location(3) texture_scale: vec4f,
  @location(4) blend_parameters: vec4f,
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
  var output: VertexOutput;
  output.position = frame_uniform.view_projection * model * vec4f(position, 1.0);
  output.normal = normalize(mat3x3f(model[0].xyz, model[1].xyz, model[2].xyz) * normal);
  output.local_position = position;
  output.color_and_emissive = color_and_emissive;
  output.texture_scale = texture_scale;
  output.blend_parameters = blend_parameters;
  return output;
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.local_position.xy * input.texture_scale.xy + vec2f(0.5);
  let primary = textureSample(model_texture, model_sampler, uv);
  let secondary = textureSample(secondary_model_texture, model_sampler, uv);
  let authored_blend = clamp(input.blend_parameters.x, 0.0, 1.0);
  let texture_color = mix(primary, secondary, authored_blend);
  let lighting = ink_toon_lighting(
    input.normal,
    frame_uniform.light_direction.xyz,
    frame_uniform.light_colour.rgb,
    frame_uniform.light_colour.a,
  );
  let linear_color = ink_srgb_to_linear(
    input.color_and_emissive.rgb * texture_color.rgb,
  );
  return vec4f(
    ink_linear_to_srgb(
      linear_color * (lighting + vec3f(input.color_and_emissive.a)),
    ),
    texture_color.a,
  );
}
`;
