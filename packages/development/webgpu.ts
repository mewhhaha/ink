import type { ModelMesh } from "@ink/assets/mesh.ts";
import { legacy_preview_camera } from "@ink/camera/legacy.ts";
import { quat_from_axis_angle, quat_multiply } from "@ink/math/quaternion.ts";
import { transform, transform_to_mat4 } from "@ink/math/transform.ts";
import { vec3 } from "@ink/math/vector.ts";
import { scene_id, scene_node_id } from "@ink/scene/identity.ts";
import {
  resolve_scene_snapshot,
  type SceneNodeSource,
} from "@ink/scene/scene.ts";
import { surface_shader_source } from "@ink/rendering/surface_wgsl.ts";
import type {
  DirectionalLightCommand,
  Projection,
  RenderSnapshot,
  SceneNodeCommand,
  SceneObjectCommand,
  SemanticRegion,
} from "@ink/blot/protocol.ts";

const gpu_buffer_usage = {
  copy_dst: 0x08,
  uniform: 0x40,
  vertex: 0x20,
} as const;
const gpu_texture_usage = {
  copy_dst: 0x02,
  texture_binding: 0x04,
  render_attachment: 0x10,
} as const;

interface HtmlInCanvasElement extends HTMLCanvasElement {
  getElementTransform(element: Element, draw_transform: DOMMatrix): DOMMatrix;
  requestPaint(): void;
}

interface HtmlInCanvasQueue extends GPUQueue {
  copyElementImageToTexture(
    source: { readonly source: Element },
    destination: {
      readonly destination: { readonly texture: GPUTexture };
      readonly width: number;
      readonly height: number;
    },
  ): void;
}

interface SemanticTexture {
  readonly texture: GPUTexture;
  readonly uniform_buffer: GPUBuffer;
  readonly bind_group: GPUBindGroup;
  readonly width: number;
  readonly height: number;
  visual_fingerprint: string | undefined;
}

export interface PreviewMesh {
  readonly id: number;
  readonly model: ModelMesh;
}

export interface PreviewTexture {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export interface TextureMipLevel {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export interface PreviewRenderer {
  readonly mode: "webgpu" | "semantic_only";
  readonly adapter_description: string | null;
  readonly unavailable_reason: string | null;
  render(
    snapshot: RenderSnapshot,
    regions: readonly SemanticRegion[],
  ): void;
  on_unavailable(report: (reason: string) => void): () => void;
  replace_assets(
    meshes: readonly PreviewMesh[],
    textures: readonly PreviewTexture[],
  ): void;
  dispose(): void;
}

export { surface_shader_source };

export const preview_shader_source = `
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
  var output: VertexOutput;
  output.position = frame_uniform.view_projection * world_position;
  output.normal = normalize((model * vec4f(normal, 0.0)).xyz);
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
  let lighting = ink_toon_lighting(
    input.normal,
    frame_uniform.light_direction.xyz,
    frame_uniform.light_colour.rgb,
    frame_uniform.light_colour.a,
  );
  let lit_color = color
    * (lighting + vec3f(input.color_and_emissive.a));
  return vec4f(ink_linear_to_srgb(lit_color), texture_color.a);
}
`;

export function create_texture_mip_levels(
  texture: PreviewTexture,
): readonly TextureMipLevel[] {
  const levels: TextureMipLevel[] = [{
    width: texture.width,
    height: texture.height,
    pixels: texture.pixels,
  }];
  while (levels.at(-1)!.width > 1 || levels.at(-1)!.height > 1) {
    const source = levels.at(-1)!;
    const width = Math.max(1, Math.floor(source.width / 2));
    const height = Math.max(1, Math.floor(source.height / 2));
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let alpha_sum = 0;
        let red_sum = 0;
        let green_sum = 0;
        let blue_sum = 0;
        for (let sample_y = 0; sample_y < 2; sample_y += 1) {
          for (let sample_x = 0; sample_x < 2; sample_x += 1) {
            const clamped_x = Math.min(x * 2 + sample_x, source.width - 1);
            const clamped_y = Math.min(y * 2 + sample_y, source.height - 1);
            const source_offset = (clamped_y * source.width + clamped_x) * 4;
            const alpha = source.pixels[source_offset + 3];
            alpha_sum += alpha;
            red_sum += source.pixels[source_offset] * alpha;
            green_sum += source.pixels[source_offset + 1] * alpha;
            blue_sum += source.pixels[source_offset + 2] * alpha;
          }
        }
        const target_offset = (y * width + x) * 4;
        pixels[target_offset] = alpha_sum === 0
          ? 0
          : Math.round(red_sum / alpha_sum);
        pixels[target_offset + 1] = alpha_sum === 0
          ? 0
          : Math.round(green_sum / alpha_sum);
        pixels[target_offset + 2] = alpha_sum === 0
          ? 0
          : Math.round(blue_sum / alpha_sum);
        pixels[target_offset + 3] = Math.round(alpha_sum / 4);
      }
    }
    levels.push({ width, height, pixels });
  }
  return levels;
}

export const semantic_shader_source = `
struct SemanticUniform {
  model_view_projection: mat4x4f,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var<uniform> semantic_uniform: SemanticUniform;
@group(0) @binding(1) var semantic_texture: texture_2d<f32>;
@group(0) @binding(2) var semantic_sampler: sampler;

@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 6>(
    vec2f(-0.5, 0.5),
    vec2f(-0.5, -0.5),
    vec2f(0.5, 0.5),
    vec2f(0.5, 0.5),
    vec2f(-0.5, -0.5),
    vec2f(0.5, -0.5),
  );
  let local_position = positions[index];
  var output: VertexOutput;
  output.position = semantic_uniform.model_view_projection * vec4f(
    local_position,
    0.0,
    1.0,
  );
  output.uv = vec2f(local_position.x + 0.5, 0.5 - local_position.y);
  return output;
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  return textureSample(semantic_texture, semantic_sampler, input.uv);
}
`;

export async function create_preview_renderer(
  canvas: HTMLCanvasElement,
  meshes: readonly PreviewMesh[],
  textures: readonly PreviewTexture[],
): Promise<PreviewRenderer> {
  const mesh_ids = new Set<number>();
  for (const mesh of meshes) {
    if (mesh_ids.has(mesh.id)) {
      throw new Error(`preview contains duplicate mesh id ${mesh.id}`);
    }
    mesh_ids.add(mesh.id);
  }
  const texture_ids = new Set<number>();
  for (const texture of textures) {
    if (texture_ids.has(texture.id)) {
      throw new Error(`preview contains duplicate texture id ${texture.id}`);
    }
    texture_ids.add(texture.id);
  }
  if (!("requestPaint" in canvas) || !("getElementTransform" in canvas)) {
    return create_semantic_renderer(
      "HTML-in-Canvas is unavailable; enable chrome://flags/#canvas-draw-element",
    );
  }
  if (!navigator.gpu) {
    return create_semantic_renderer("WebGPU is not available in this renderer");
  }

  try {
    let adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
      forceFallbackAdapter: false,
    });
    if (!adapter || adapter.info.isFallbackAdapter) {
      const low_power_adapter = await navigator.gpu.requestAdapter({
        powerPreference: "low-power",
        forceFallbackAdapter: false,
      });
      if (low_power_adapter && !low_power_adapter.info.isFallbackAdapter) {
        adapter = low_power_adapter;
      }
    }
    if (!adapter) {
      return create_semantic_renderer(
        "no hardware WebGPU adapter was found",
      );
    }
    if (adapter.info.isFallbackAdapter) {
      return create_semantic_renderer(
        "the browser exposed only software WebGPU adapters; check its WebGPU hardware blocklist",
      );
    }
    const adapter_description = adapter.info.description ||
      adapter.info.architecture || adapter.info.vendor ||
      "hardware WebGPU adapter";
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!context) {
      device.destroy();
      return create_semantic_renderer(
        "the canvas could not create a WebGPU context",
      );
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
      device,
      format,
      alphaMode: "premultiplied",
      usage: gpu_texture_usage.render_attachment,
    });
    if (!("copyElementImageToTexture" in device.queue)) {
      context.unconfigure();
      device.destroy();
      return create_semantic_renderer(
        "WebGPU HTML-in-Canvas texture copies are unavailable",
      );
    }

    const html_canvas = canvas as HtmlInCanvasElement;
    const html_queue = device.queue as HtmlInCanvasQueue;

    const model_shader = device.createShaderModule({
      code: preview_shader_source,
    });
    const semantic_shader = device.createShaderModule({
      code: semantic_shader_source,
    });
    const [model_compilation, semantic_compilation] = await Promise.all([
      model_shader.getCompilationInfo(),
      semantic_shader.getCompilationInfo(),
    ]);
    const shader_errors = [
      ...model_compilation.messages,
      ...semantic_compilation.messages,
    ].filter(
      (message) => message.type === "error",
    );
    if (shader_errors.length > 0) {
      context.unconfigure();
      device.destroy();
      return create_semantic_renderer(
        `preview shader failed: ${
          shader_errors.map((message) => message.message).join("; ")
        }`,
      );
    }

    device.pushErrorScope("validation");
    const model_pipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: {
        module: model_shader,
        entryPoint: "vertex_main",
        buffers: [
          {
            arrayStride: 24,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
            ],
          },
          {
            arrayStride: 112,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 2, offset: 0, format: "float32x4" },
              { shaderLocation: 3, offset: 16, format: "float32x4" },
              { shaderLocation: 4, offset: 32, format: "float32x4" },
              { shaderLocation: 5, offset: 48, format: "float32x4" },
              { shaderLocation: 6, offset: 64, format: "float32x4" },
              { shaderLocation: 7, offset: 80, format: "float32x4" },
              { shaderLocation: 8, offset: 96, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: {
        module: model_shader,
        entryPoint: "fragment_main",
        targets: [{
          format,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        }],
      },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
    const semantic_pipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: {
        module: semantic_shader,
        entryPoint: "vertex_main",
      },
      fragment: {
        module: semantic_shader,
        entryPoint: "fragment_main",
        targets: [{
          format,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    });
    const pipeline_error = await device.popErrorScope();
    if (pipeline_error) {
      context.unconfigure();
      device.destroy();
      return create_semantic_renderer(
        `preview pipeline validation failed: ${pipeline_error.message}`,
      );
    }
    const mesh_buffers = new Map<number, {
      readonly vertex_buffer: GPUBuffer;
      readonly vertex_count: number;
    }>();
    const texture_buffers = new Map<number, GPUTexture>();
    const frame_uniform_buffer = device.createBuffer({
      size: 96,
      usage: gpu_buffer_usage.uniform | gpu_buffer_usage.copy_dst,
    });
    const object_batch_resources = new Map<string, {
      readonly texture: number | null;
      readonly secondary_texture: number | null;
      readonly instance_buffer: GPUBuffer;
      readonly instance_capacity: number;
      readonly bind_group: GPUBindGroup;
      uploaded_object_revision: number;
    }>();
    const replace_assets = (
      next_meshes: readonly PreviewMesh[],
      next_textures: readonly PreviewTexture[],
    ) => {
      const next_mesh_buffers = new Map<number, {
        readonly vertex_buffer: GPUBuffer;
        readonly vertex_count: number;
      }>();
      for (const mesh of next_meshes) {
        const vertex_buffer = device.createBuffer({
          size: mesh.model.vertices.byteLength,
          usage: gpu_buffer_usage.vertex | gpu_buffer_usage.copy_dst,
        });
        device.queue.writeBuffer(vertex_buffer, 0, mesh.model.vertices);
        next_mesh_buffers.set(mesh.id, {
          vertex_buffer,
          vertex_count: mesh.model.vertex_count,
        });
      }
      const next_texture_buffers = new Map<number, GPUTexture>();
      for (const texture of next_textures) {
        const mip_levels = create_texture_mip_levels(texture);
        const gpu_texture = device.createTexture({
          size: [texture.width, texture.height],
          mipLevelCount: mip_levels.length,
          format: "rgba8unorm",
          usage: gpu_texture_usage.copy_dst | gpu_texture_usage.texture_binding,
        });
        for (const [mip_level, level] of mip_levels.entries()) {
          const bytes_per_row = Math.ceil(level.width * 4 / 256) * 256;
          const upload = new Uint8Array(bytes_per_row * level.height);
          for (let row = 0; row < level.height; row += 1) {
            upload.set(
              level.pixels.subarray(
                row * level.width * 4,
                (row + 1) * level.width * 4,
              ),
              row * bytes_per_row,
            );
          }
          device.queue.writeTexture(
            { texture: gpu_texture, mipLevel: mip_level },
            upload,
            { bytesPerRow: bytes_per_row, rowsPerImage: level.height },
            [level.width, level.height],
          );
        }
        next_texture_buffers.set(texture.id, gpu_texture);
      }
      for (const mesh of mesh_buffers.values()) mesh.vertex_buffer.destroy();
      mesh_buffers.clear();
      for (const [id, mesh] of next_mesh_buffers) mesh_buffers.set(id, mesh);
      for (const texture of texture_buffers.values()) texture.destroy();
      texture_buffers.clear();
      for (const [id, texture] of next_texture_buffers) {
        texture_buffers.set(id, texture);
      }
      for (const resources of object_batch_resources.values()) {
        resources.instance_buffer.destroy();
      }
      object_batch_resources.clear();
    };

    let depth_texture: GPUTexture | undefined;
    let depth_width = 0;
    let depth_height = 0;
    const fallback_texture = device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: gpu_texture_usage.copy_dst | gpu_texture_usage.texture_binding,
    });
    device.queue.writeTexture(
      { texture: fallback_texture },
      new Uint8Array([255, 255, 255, 255]),
      {},
      [1, 1],
    );
    const model_sampler = device.createSampler({
      addressModeU: "repeat",
      addressModeV: "repeat",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
    });
    const semantic_sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });
    const semantic_textures = new Map<string, SemanticTexture>();
    const unavailable_reports = new Set<(reason: string) => void>();
    let unavailable_reason: string | null = null;
    let disposed = false;
    let semantic_elements = new Map<string, HTMLElement>();
    let last_snapshot: RenderSnapshot | undefined;
    let last_regions: readonly SemanticRegion[] = [];
    let last_region_fingerprint = "";
    let semantic_paint_frame: number | undefined;
    let semantic_render_pending = false;
    let prepared_nodes: readonly SceneNodeCommand[] = [];
    let prepared_objects: readonly SceneObjectCommand[] = [];
    let prepared_resolved_objects: ReadonlyMap<number, ResolvedSceneObject> =
      new Map();
    let prepared_batches: readonly {
      readonly batch: SceneObjectBatch;
      readonly instance_values: Float32Array;
    }[] = [];
    let object_revision = 0;

    replace_assets(meshes, textures);

    const mark_unavailable = (reason: string) => {
      if (unavailable_reason || disposed) return;
      unavailable_reason = reason;
      console.error(`WebGPU preview unavailable: ${reason}`);
      for (const report of unavailable_reports) report(reason);
    };

    void device.lost.then((lost) => {
      if (disposed) return;
      mark_unavailable(
        `device was lost (${lost.reason}): ${
          lost.message || "no reason provided"
        }`,
      );
    });

    const render_frame = (
      snapshot: RenderSnapshot,
      regions: readonly SemanticRegion[],
    ) => {
      if (disposed) throw new Error("preview renderer is disposed");
      if (unavailable_reason) return;

      try {
        let missing_semantic_paint = false;
        if (
          !depth_texture || depth_width !== canvas.width ||
          depth_height !== canvas.height
        ) {
          depth_texture?.destroy();
          depth_width = Math.max(1, canvas.width);
          depth_height = Math.max(1, canvas.height);
          depth_texture = device.createTexture({
            size: [depth_width, depth_height],
            format: "depth24plus",
            usage: gpu_texture_usage.render_attachment,
          });
        }

        const surface = context.getCurrentTexture();
        const commands = device.createCommandEncoder();
        const pass = commands.beginRenderPass({
          colorAttachments: [{
            view: surface.createView(),
            clearValue: { r: 0.012, g: 0.018, b: 0.035, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
          depthStencilAttachment: {
            view: depth_texture.createView(),
            depthClearValue: 1,
            depthLoadOp: "clear",
            depthStoreOp: "store",
          },
        });
        pass.setPipeline(model_pipeline);

        if (
          !scene_nodes_equal(prepared_nodes, snapshot.nodes) ||
          !scene_objects_equal(prepared_objects, snapshot.objects)
        ) {
          prepared_nodes = snapshot.nodes;
          prepared_objects = snapshot.objects;
          prepared_resolved_objects = resolve_scene_objects(
            snapshot.objects,
            snapshot.nodes,
          );
          prepared_batches = batch_scene_objects(
            snapshot.objects,
            prepared_resolved_objects,
          ).map((batch) => ({
            batch,
            instance_values: scene_object_instances(batch),
          }));
          object_revision += 1;
        }
        const active_batch_keys = new Set<string>();
        device.queue.writeBuffer(
          frame_uniform_buffer,
          0,
          scene_frame_uniform(
            snapshot.directional_light,
            snapshot.projection,
            snapshot.camera_zoom,
            canvas.clientWidth,
            canvas.clientHeight,
          ),
        );
        for (const prepared_batch of prepared_batches) {
          const { batch, instance_values } = prepared_batch;
          active_batch_keys.add(batch.key);
          const mesh = mesh_buffers.get(batch.mesh);
          if (!mesh) {
            throw new Error(
              `scene batch ${batch.key} selects missing mesh ${batch.mesh}`,
            );
          }
          const texture = batch.texture === null
            ? fallback_texture
            : texture_buffers.get(batch.texture);
          if (!texture) {
            throw new Error(
              `scene batch ${batch.key} selects missing texture ${batch.texture}`,
            );
          }
          const secondary_texture = batch.secondary_texture === null
            ? fallback_texture
            : texture_buffers.get(batch.secondary_texture);
          if (!secondary_texture) {
            throw new Error(
              `scene batch ${batch.key} selects missing secondary texture ${batch.secondary_texture}`,
            );
          }
          let resources = object_batch_resources.get(batch.key);
          if (!resources) {
            const instance_capacity = batch.instances.length;
            const instance_buffer = device.createBuffer({
              size: instance_capacity * scene_object_instance_size,
              usage: gpu_buffer_usage.vertex | gpu_buffer_usage.copy_dst,
            });
            resources = {
              texture: batch.texture,
              secondary_texture: batch.secondary_texture,
              instance_buffer,
              instance_capacity,
              uploaded_object_revision: -1,
              bind_group: device.createBindGroup({
                layout: model_pipeline.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: { buffer: frame_uniform_buffer } },
                  { binding: 1, resource: texture.createView() },
                  { binding: 2, resource: secondary_texture.createView() },
                  { binding: 3, resource: model_sampler },
                ],
              }),
            };
            object_batch_resources.set(batch.key, resources);
          } else if (resources.instance_capacity < batch.instances.length) {
            resources.instance_buffer.destroy();
            resources = {
              ...resources,
              instance_buffer: device.createBuffer({
                size: batch.instances.length * scene_object_instance_size,
                usage: gpu_buffer_usage.vertex | gpu_buffer_usage.copy_dst,
              }),
              instance_capacity: batch.instances.length,
              uploaded_object_revision: -1,
            };
            object_batch_resources.set(batch.key, resources);
          }
          if (resources.uploaded_object_revision !== object_revision) {
            device.queue.writeBuffer(
              resources.instance_buffer,
              0,
              instance_values,
            );
            resources.uploaded_object_revision = object_revision;
          }
          pass.setVertexBuffer(0, mesh.vertex_buffer);
          pass.setVertexBuffer(1, resources.instance_buffer);
          pass.setBindGroup(0, resources.bind_group);
          pass.draw(mesh.vertex_count, batch.instances.length);
        }
        for (const [key, resources] of object_batch_resources) {
          if (active_batch_keys.has(key)) continue;
          resources.instance_buffer.destroy();
          object_batch_resources.delete(key);
        }

        pass.setPipeline(semantic_pipeline);
        for (const region of regions) {
          const element = semantic_elements.get(region.id);
          let model_view_projection: Float32Array;
          if (region.placement.type === "scene_object") {
            const resolved = prepared_resolved_objects.get(
              region.placement.object,
            );
            if (!resolved) {
              throw new Error(
                `semantic region ${
                  JSON.stringify(region.id)
                } attaches to missing scene object ${region.placement.object}`,
              );
            }
            if (element) {
              element.style.visibility = resolved.visible ? "" : "hidden";
            }
            if (!resolved.visible) continue;
            model_view_projection = semantic_model_view_projection_from_model(
              region.placement,
              resolved.model,
              snapshot.projection,
              snapshot.camera_zoom,
              canvas.clientWidth,
              canvas.clientHeight,
            );
          } else {
            if (element) element.style.visibility = "";
            model_view_projection = viewport_model_view_projection(
              region.placement,
              region.element_size,
              canvas.clientWidth,
              canvas.clientHeight,
            );
          }
          const semantic_texture = semantic_textures.get(region.id);
          if (!semantic_texture) continue;
          device.queue.writeBuffer(
            semantic_texture.uniform_buffer,
            0,
            model_view_projection,
          );
          if (element) {
            const element_width = Math.max(1, element.offsetWidth);
            const element_height = Math.max(1, element.offsetHeight);
            const css_to_unit_space = new DOMMatrix()
              .scale(1 / element_width, -1 / element_height, 1)
              .translate(-element_width / 2, -element_height / 2);
            const clip_to_canvas = new DOMMatrix()
              .translate(canvas.width / 2, canvas.height / 2)
              .scale(canvas.width / 2, -canvas.height / 2, 1);
            const draw_transform = clip_to_canvas
              .multiply(new DOMMatrix(Array.from(model_view_projection)))
              .multiply(css_to_unit_space);
            try {
              element.style.transform = html_canvas.getElementTransform(
                element,
                draw_transform,
              ).toString();
            } catch (error) {
              if (
                !(error instanceof DOMException) ||
                !error.message.includes("No cached paint record")
              ) {
                throw error;
              }
              missing_semantic_paint = true;
              continue;
            }
            if (getComputedStyle(element).opacity === "0") continue;
          }

          pass.setBindGroup(0, semantic_texture.bind_group);
          pass.draw(6);
        }

        pass.end();
        device.queue.submit([commands.finish()]);
        semantic_render_pending = missing_semantic_paint;
      } catch (error) {
        mark_unavailable(
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    const paint_semantic_elements = () => {
      if (disposed || unavailable_reason) return;
      let semantic_texture_changed = false;
      semantic_elements = new Map(
        Array.from(canvas.children).flatMap((element) => {
          if (!(element instanceof HTMLElement)) return [];
          const region_id = element.dataset.inkSemanticId;
          return region_id ? [[region_id, element] as const] : [];
        }),
      );
      const active_region_ids = new Set(
        last_regions.map((region) => region.id),
      );
      for (const [region_id, semantic_texture] of semantic_textures) {
        if (active_region_ids.has(region_id)) continue;
        semantic_texture.texture.destroy();
        semantic_texture.uniform_buffer.destroy();
        semantic_textures.delete(region_id);
      }
      const pixel_ratio = canvas.width / Math.max(1, canvas.clientWidth);
      for (const region of last_regions) {
        const element = semantic_elements.get(region.id);
        if (!element) continue;
        const size = semantic_texture_size(region.element_size, pixel_ratio);
        let semantic_texture = semantic_textures.get(region.id);
        if (
          semantic_texture &&
          (semantic_texture.width !== size.width ||
            semantic_texture.height !== size.height)
        ) {
          semantic_texture.texture.destroy();
          semantic_texture.uniform_buffer.destroy();
          semantic_textures.delete(region.id);
          semantic_texture = undefined;
        }
        if (!semantic_texture) {
          const texture = device.createTexture({
            size: [size.width, size.height],
            format: "rgba8unorm",
            usage: gpu_texture_usage.copy_dst |
              gpu_texture_usage.texture_binding |
              gpu_texture_usage.render_attachment,
          });
          const uniform_buffer = device.createBuffer({
            size: 64,
            usage: gpu_buffer_usage.uniform | gpu_buffer_usage.copy_dst,
          });
          semantic_texture = {
            texture,
            uniform_buffer,
            bind_group: device.createBindGroup({
              layout: semantic_pipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: uniform_buffer } },
                { binding: 1, resource: texture.createView() },
                { binding: 2, resource: semantic_sampler },
              ],
            }),
            width: size.width,
            height: size.height,
            visual_fingerprint: undefined,
          };
          semantic_textures.set(region.id, semantic_texture);
        }
        const computed_style = getComputedStyle(element);
        const visual_fingerprint = JSON.stringify([
          element.textContent,
          element.getAttribute("aria-pressed"),
          element.getAttribute("data-selected"),
          computed_style.backgroundColor,
          computed_style.backgroundImage,
          computed_style.borderColor,
          computed_style.borderRadius,
          computed_style.borderWidth,
          computed_style.clipPath,
          computed_style.color,
          computed_style.filter,
          computed_style.fontFamily,
          computed_style.fontSize,
          computed_style.fontWeight,
          computed_style.opacity,
        ]);
        if (semantic_texture.visual_fingerprint === visual_fingerprint) {
          continue;
        }
        try {
          html_queue.copyElementImageToTexture(
            { source: element },
            {
              destination: { texture: semantic_texture.texture },
              width: size.width,
              height: size.height,
            },
          );
          semantic_texture.visual_fingerprint = visual_fingerprint;
          semantic_texture_changed = true;
        } catch (error) {
          mark_unavailable(
            error instanceof Error ? error.message : String(error),
          );
          return;
        }
      }
      if (
        last_snapshot && (semantic_texture_changed || semantic_render_pending)
      ) {
        render_frame(last_snapshot, last_regions);
      }
    };
    canvas.addEventListener("paint", paint_semantic_elements);

    return {
      get mode() {
        return unavailable_reason ? "semantic_only" : "webgpu";
      },
      adapter_description,
      get unavailable_reason() {
        return unavailable_reason;
      },
      render(snapshot, regions) {
        const region_fingerprint = JSON.stringify(regions);
        const semantic_content_changed =
          region_fingerprint !== last_region_fingerprint;
        last_snapshot = snapshot;
        last_regions = regions;
        last_region_fingerprint = region_fingerprint;
        render_frame(snapshot, regions);
        const pixel_ratio = canvas.width / Math.max(1, canvas.clientWidth);
        const semantic_paint_required = regions.some((region) => {
          const semantic_texture = semantic_textures.get(region.id);
          if (!semantic_texture) return true;
          const size = semantic_texture_size(region.element_size, pixel_ratio);
          return semantic_texture.width !== size.width ||
            semantic_texture.height !== size.height;
        });
        if (semantic_content_changed || semantic_paint_required) {
          if (semantic_paint_frame !== undefined) {
            cancelAnimationFrame(semantic_paint_frame);
          }
          semantic_paint_frame = requestAnimationFrame(() => {
            // The first frame may precede React's semantic DOM commit.
            semantic_paint_frame = requestAnimationFrame(() => {
              semantic_paint_frame = undefined;
              if (!disposed) html_canvas.requestPaint();
            });
          });
        }
      },
      on_unavailable(report) {
        unavailable_reports.add(report);
        return () => unavailable_reports.delete(report);
      },
      replace_assets,
      dispose() {
        if (disposed) return;
        disposed = true;
        if (semantic_paint_frame !== undefined) {
          cancelAnimationFrame(semantic_paint_frame);
        }
        depth_texture?.destroy();
        fallback_texture.destroy();
        frame_uniform_buffer.destroy();
        for (const mesh of mesh_buffers.values()) mesh.vertex_buffer.destroy();
        for (const texture of texture_buffers.values()) texture.destroy();
        for (const resources of object_batch_resources.values()) {
          resources.instance_buffer.destroy();
        }
        for (const semantic_texture of semantic_textures.values()) {
          semantic_texture.texture.destroy();
          semantic_texture.uniform_buffer.destroy();
        }
        semantic_textures.clear();
        unavailable_reports.clear();
        canvas.removeEventListener("paint", paint_semantic_elements);
        context.unconfigure();
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("WebGPU preview initialization failed", error);
    return create_semantic_renderer(
      `WebGPU preview initialization failed: ${reason}`,
    );
  }
}

export function semantic_texture_size(
  element_size: SemanticRegion["element_size"],
  pixel_ratio: number,
): {
  readonly width: number;
  readonly height: number;
} {
  return {
    width: Math.max(1, Math.round(element_size.width * pixel_ratio)),
    height: Math.max(1, Math.round(element_size.height * pixel_ratio)),
  };
}

export function semantic_model_view_projection(
  placement: Extract<SemanticRegion["placement"], { type: "scene_object" }>,
  object: SceneObjectCommand,
  projection: Projection,
  camera_zoom: number,
  width: number,
  height: number,
): Float32Array {
  return semantic_model_view_projection_from_model(
    placement,
    new Float32Array(transform_to_mat4(scene_node_transform(object))),
    projection,
    camera_zoom,
    width,
    height,
  );
}

function semantic_model_view_projection_from_model(
  placement: Extract<SemanticRegion["placement"], { type: "scene_object" }>,
  object_model: Float32Array,
  projection: Projection,
  camera_zoom: number,
  width: number,
  height: number,
): Float32Array {
  const offset = translation_matrix(
    placement.offset[0] / 1_000_000,
    placement.offset[1] / 1_000_000,
    placement.offset[2] / 1_000_000,
  );
  const plane = scale_xyz_matrix(
    placement.size[0] / 1_000_000,
    placement.size[1] / 1_000_000,
    1,
  );
  const model = multiply_matrices(
    object_model,
    multiply_matrices(offset, plane),
  );
  return multiply_matrices(
    view_projection_matrix(projection, camera_zoom, width, height),
    model,
  );
}

export function viewport_model_view_projection(
  placement: Extract<SemanticRegion["placement"], { type: "viewport" }>,
  element_size: SemanticRegion["element_size"],
  width: number,
  height: number,
): Float32Array {
  const safe_width = Math.max(1, width);
  const safe_height = Math.max(1, height);
  const centered = placement.anchor === "center";
  const anchored_right = placement.anchor === "top_right" ||
    placement.anchor === "bottom_right";
  const anchored_bottom = placement.anchor === "bottom_left" ||
    placement.anchor === "bottom_right";
  const center_x = centered
    ? safe_width / 2 + placement.inset[0]
    : anchored_right
    ? safe_width - placement.inset[0] - element_size.width / 2
    : placement.inset[0] + element_size.width / 2;
  const center_y = centered
    ? safe_height / 2 + placement.inset[1]
    : anchored_bottom
    ? safe_height - placement.inset[1] - element_size.height / 2
    : placement.inset[1] + element_size.height / 2;
  const center = translation_matrix(
    center_x / safe_width * 2 - 1,
    1 - center_y / safe_height * 2,
    0,
  );
  const size = scale_xyz_matrix(
    element_size.width / safe_width * 2,
    element_size.height / safe_height * 2,
    1,
  );
  return multiply_matrices(center, size);
}

export function project_model_origin(
  position: readonly [number, number, number],
  projection: Projection,
  camera_zoom: number,
  width: number,
  height: number,
): readonly [number, number] {
  const model = translation_matrix(
    position[0] / 1_000_000,
    position[1] / 1_000_000,
    position[2] / 1_000_000,
  );
  const view_projection = view_projection_matrix(
    projection,
    camera_zoom,
    width,
    height,
  );
  const clip = transform_point(multiply_matrices(view_projection, model), [
    0,
    0,
    0,
    1,
  ]);
  return [
    (clip[0] / clip[3] + 1) * width / 2,
    (1 - clip[1] / clip[3]) * height / 2,
  ];
}

export function create_semantic_renderer(reason: string): PreviewRenderer {
  return {
    mode: "semantic_only",
    adapter_description: null,
    unavailable_reason: reason,
    render() {},
    on_unavailable() {
      return () => {};
    },
    replace_assets() {},
    dispose() {},
  };
}

const scene_object_instance_float_count = 28;
const scene_object_instance_size = scene_object_instance_float_count * 4;

function scene_frame_uniform(
  directional_light: DirectionalLightCommand,
  projection: Projection,
  camera_zoom: number,
  width: number,
  height: number,
): Float32Array {
  return new Float32Array([
    ...view_projection_matrix(projection, camera_zoom, width, height),
    ...directional_light.direction,
    0,
    ...directional_light.color,
    directional_light.intensity,
  ]);
}

function scene_object_instances(batch: SceneObjectBatch): Float32Array {
  const values = new Float32Array(
    batch.instances.length * scene_object_instance_float_count,
  );
  for (const [index, instance] of batch.instances.entries()) {
    const offset = index * scene_object_instance_float_count;
    values.set(instance.model, offset);
    values.set(
      [...instance.object.color, instance.object.emissive],
      offset + 16,
    );
    values.set(
      [...instance.object.texture_scale, ...instance.object.texture_offset],
      offset + 20,
    );
    values.set([
      instance.object.blend_edges,
      instance.object.variation_seed,
      instance.object.surface_mode,
      instance.object.path_connections,
    ], offset + 24);
  }
  return values;
}

function view_projection_matrix(
  projection: Projection,
  camera_zoom: number,
  width: number,
  height: number,
): Float32Array {
  return new Float32Array(
    legacy_preview_camera(
      projection,
      camera_zoom,
      width,
      height,
    ).stable_view_projection,
  );
}

export interface ResolvedSceneObject {
  readonly model: Float32Array;
  readonly visible: boolean;
}

export interface SceneObjectBatch {
  readonly key: string;
  readonly mesh: number;
  readonly texture: number | null;
  readonly secondary_texture: number | null;
  readonly instances: readonly {
    readonly object: SceneObjectCommand;
    readonly model: Float32Array;
  }[];
}

export function batch_scene_objects(
  objects: readonly SceneObjectCommand[],
  resolved_objects: ReadonlyMap<number, ResolvedSceneObject>,
): readonly SceneObjectBatch[] {
  const batches = new Map<string, {
    readonly key: string;
    readonly mesh: number;
    readonly texture: number | null;
    readonly secondary_texture: number | null;
    readonly instances: {
      readonly object: SceneObjectCommand;
      readonly model: Float32Array;
    }[];
  }>();
  for (const object of objects) {
    const resolved = resolved_objects.get(object.id);
    if (!resolved) {
      throw new Error(`scene object ${object.id} has no resolved transform`);
    }
    if (!resolved.visible) continue;
    const key = JSON.stringify([
      object.mesh,
      object.texture,
      object.secondary_texture,
    ]);
    const existing = batches.get(key);
    if (existing) {
      existing.instances.push({ object, model: resolved.model });
      continue;
    }
    batches.set(key, {
      key,
      mesh: object.mesh,
      texture: object.texture,
      secondary_texture: object.secondary_texture,
      instances: [{ object, model: resolved.model }],
    });
  }
  return [...batches.values()];
}

export function scene_objects_equal(
  left: readonly SceneObjectCommand[],
  right: readonly SceneObjectCommand[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const left_object = left[index];
    const right_object = right[index];
    if (
      left_object.id !== right_object.id ||
      left_object.mesh !== right_object.mesh ||
      left_object.parent !== right_object.parent ||
      left_object.emissive !== right_object.emissive ||
      left_object.texture !== right_object.texture ||
      left_object.secondary_texture !== right_object.secondary_texture ||
      left_object.blend_edges !== right_object.blend_edges ||
      left_object.variation_seed !== right_object.variation_seed ||
      left_object.surface_mode !== right_object.surface_mode ||
      left_object.path_connections !== right_object.path_connections ||
      left_object.visible !== right_object.visible ||
      left_object.color[0] !== right_object.color[0] ||
      left_object.color[1] !== right_object.color[1] ||
      left_object.color[2] !== right_object.color[2] ||
      left_object.texture_scale[0] !== right_object.texture_scale[0] ||
      left_object.texture_scale[1] !== right_object.texture_scale[1] ||
      left_object.texture_offset[0] !== right_object.texture_offset[0] ||
      left_object.texture_offset[1] !== right_object.texture_offset[1] ||
      left_object.rotation_radians[0] !== right_object.rotation_radians[0] ||
      left_object.rotation_radians[1] !== right_object.rotation_radians[1] ||
      left_object.rotation_radians[2] !== right_object.rotation_radians[2] ||
      left_object.position[0] !== right_object.position[0] ||
      left_object.position[1] !== right_object.position[1] ||
      left_object.position[2] !== right_object.position[2] ||
      left_object.scale[0] !== right_object.scale[0] ||
      left_object.scale[1] !== right_object.scale[1] ||
      left_object.scale[2] !== right_object.scale[2]
    ) return false;
  }
  return true;
}

export function scene_nodes_equal(
  left: readonly SceneNodeCommand[],
  right: readonly SceneNodeCommand[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const left_node = left[index];
    const right_node = right[index];
    if (
      left_node.id !== right_node.id ||
      left_node.parent !== right_node.parent ||
      left_node.visible !== right_node.visible ||
      left_node.rotation_radians[0] !== right_node.rotation_radians[0] ||
      left_node.rotation_radians[1] !== right_node.rotation_radians[1] ||
      left_node.rotation_radians[2] !== right_node.rotation_radians[2] ||
      left_node.position[0] !== right_node.position[0] ||
      left_node.position[1] !== right_node.position[1] ||
      left_node.position[2] !== right_node.position[2] ||
      left_node.scale[0] !== right_node.scale[0] ||
      left_node.scale[1] !== right_node.scale[1] ||
      left_node.scale[2] !== right_node.scale[2]
    ) return false;
  }
  return true;
}

export function resolve_scene_objects(
  objects: readonly SceneObjectCommand[],
  nodes: readonly SceneNodeCommand[] = [],
): ReadonlyMap<number, ResolvedSceneObject> {
  const commands: readonly (SceneNodeCommand | SceneObjectCommand)[] = [
    ...nodes,
    ...objects,
  ];
  const sources: SceneNodeSource[] = commands.map((command) => ({
    id: scene_node_id(command.id, 0),
    ...(command.parent === null
      ? {}
      : { parent: scene_node_id(command.parent, 0) }),
    local_transform: scene_node_transform(command),
    active: command.visible,
    layers: 0xffff_ffff,
    attachments: new Map(),
  }));
  const snapshot = resolve_scene_snapshot(
    scene_id("development.preview"),
    0,
    sources,
  );
  if (snapshot.type === "invalid_hierarchy") {
    throw new Error(`preview scene is invalid: ${snapshot.reason}`);
  }
  return new Map(snapshot.snapshot.nodes.map((node) => [
    node.id.index,
    {
      model: new Float32Array(node.world_transform),
      visible: node.world_active,
    },
  ]));
}

function scene_node_transform(
  node: SceneNodeCommand | SceneObjectCommand,
) {
  const x_axis = vec3(1, 0, 0);
  const y_axis = vec3(0, 1, 0);
  const z_axis = vec3(0, 0, 1);
  return transform(
    vec3(
      node.position[0] / 1_000_000,
      node.position[1] / 1_000_000,
      node.position[2] / 1_000_000,
    ),
    quat_multiply(
      quat_from_axis_angle(z_axis, node.rotation_radians[2]),
      quat_multiply(
        quat_from_axis_angle(y_axis, node.rotation_radians[1]),
        quat_from_axis_angle(x_axis, node.rotation_radians[0]),
      ),
    ),
    vec3(
      node.scale[0] / 1_000_000,
      node.scale[1] / 1_000_000,
      node.scale[2] / 1_000_000,
    ),
  );
}

function multiply_matrices(
  left: Float32Array,
  right: Float32Array,
): Float32Array {
  const product = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let index = 0; index < 4; index += 1) {
        product[column * 4 + row] += left[index * 4 + row] *
          right[column * 4 + index];
      }
    }
  }
  return product;
}

function transform_point(
  matrix: Float32Array,
  point: readonly [number, number, number, number],
): readonly [number, number, number, number] {
  const component = (row: number) =>
    matrix[row] * point[0] + matrix[4 + row] * point[1] +
    matrix[8 + row] * point[2] + matrix[12 + row] * point[3];
  return [component(0), component(1), component(2), component(3)];
}

function translation_matrix(x: number, y: number, z: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

function scale_xyz_matrix(x: number, y: number, z: number): Float32Array {
  return new Float32Array([
    x,
    0,
    0,
    0,
    0,
    y,
    0,
    0,
    0,
    0,
    z,
    0,
    0,
    0,
    0,
    1,
  ]);
}
