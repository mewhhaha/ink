import type { Mat4 } from "@ink/math/matrix.ts";
import type { LinearRgb } from "@ink/materials/color.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import {
  pack_ray_tracing_gpu_scene,
  type PathTracingFramePlan,
  type PathTracingTextureLayer,
  type PathTracingTextureLayers,
} from "./path_tracing.ts";
import { path_denoise_shader, path_trace_shader } from "./path_tracing_wgsl.ts";
import { format_shader_compilation_diagnostic } from "./shader_diagnostics.ts";

type TracedFramePlan = Extract<
  PathTracingFramePlan,
  { readonly type: "path_traced" }
>;

export interface PathTracingComputeFrame {
  readonly ambient_light: LinearRgb;
  readonly camera_position: Vec3;
  readonly clear_color: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly a: number;
  };
  readonly commands: GPUCommandEncoder;
  readonly fog_color: LinearRgb;
  readonly fog_density: number;
  readonly hdr: GPUTexture;
  readonly inverse_view_projection: Mat4;
  readonly plan: TracedFramePlan;
  readonly target_height: number;
  readonly target_width: number;
  readonly textures: readonly PathTracingTextureSource[];
}

export interface PathTracingTextureSource {
  readonly color_space: "linear" | "srgb";
  readonly id: string;
  readonly source: ImageBitmap;
}

export interface PathTracingCompute {
  encode(frame: PathTracingComputeFrame): void;
  dispose(): void;
}

const buffer_usage = {
  copy_dst: 0x08,
  storage: 0x80,
  uniform: 0x40,
} as const;
const texture_usage = {
  copy_dst: 0x02,
  render_attachment: 0x10,
  storage_binding: 0x08,
  texture_binding: 0x04,
} as const;
const missing_node = 0xffff_ffff;

interface PathTracingSceneBuffers {
  readonly blas: GPUBuffer;
  readonly blas_indices: GPUBuffer;
  readonly geometries: GPUBuffer;
  readonly instances: GPUBuffer;
  readonly surfaces: GPUBuffer;
  readonly triangles: GPUBuffer;
  readonly tlas: GPUBuffer;
  readonly tlas_indices: GPUBuffer;
}

interface PathTracingTargets {
  readonly accumulation: readonly [GPUTexture, GPUTexture];
  readonly depth: GPUTexture;
  readonly height: number;
  readonly moments: readonly [GPUTexture, GPUTexture];
  readonly normal: GPUTexture;
  readonly width: number;
}

interface PathTracingTextureSet extends PathTracingTextureLayers {
  readonly base_color_texture: GPUTexture;
  readonly normal_texture: GPUTexture;
  readonly sampler: GPUSampler;
  readonly sources: readonly PathTracingTextureSource[];
}

interface PathTracingTextureArray {
  readonly layers: ReadonlyMap<string, PathTracingTextureLayer>;
  readonly texture: GPUTexture;
}

interface InitialPathTracingResources {
  readonly denoise_uniform: GPUBuffer;
  readonly path_uniform: GPUBuffer;
  readonly scene_buffers: PathTracingSceneBuffers;
  readonly texture_set: PathTracingTextureSet;
}

export async function create_path_tracing_compute(
  device: GPUDevice,
): Promise<PathTracingCompute> {
  const trace_module = device.createShaderModule({
    code: path_trace_shader.source,
  });
  const denoise_module = device.createShaderModule({
    code: path_denoise_shader.source,
  });
  const compiled_shaders = [
    { module: trace_module, source: path_trace_shader },
    { module: denoise_module, source: path_denoise_shader },
  ] as const;
  const compilation = await Promise.all(
    compiled_shaders.map(({ module }) => module.getCompilationInfo()),
  );
  const errors = compilation.flatMap(({ messages }, index) =>
    [...messages].filter(({ type }) => type === "error").map((message) =>
      format_shader_compilation_diagnostic(
        compiled_shaders[index].source,
        message,
      )
    )
  );
  if (errors.length > 0) {
    throw new Error(
      `path tracing shader failed: ${errors.join("; ")}`,
    );
  }
  const trace_pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module: trace_module, entryPoint: "path_trace_main" },
  });
  const denoise_pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module: denoise_module, entryPoint: "path_denoise_main" },
  });
  const initial_resources = create_initial_path_tracing_resources(device);
  const path_uniform = initial_resources.path_uniform;
  const denoise_uniform = initial_resources.denoise_uniform;
  let scene_buffers = initial_resources.scene_buffers;
  let targets: PathTracingTargets | undefined;
  let texture_set = initial_resources.texture_set;
  let latest_accumulation = 0 as 0 | 1;
  let disposed = false;

  function ensure_targets(
    width: number,
    height: number,
  ): PathTracingTargets {
    if (targets?.width === width && targets.height === height) return targets;
    const replacement = create_path_targets(device, width, height);
    const previous = targets;
    targets = replacement;
    latest_accumulation = 0;
    destroy_targets(previous);
    return replacement;
  }

  return {
    encode(frame) {
      if (disposed) throw new Error("path tracing compute is disposed");
      const synchronized_textures = synchronize_path_texture_set(
        device,
        texture_set,
        frame.textures,
      );
      texture_set = synchronized_textures.texture_set;
      scene_buffers = synchronize_scene_buffers(
        device,
        scene_buffers,
        frame.plan,
        texture_set,
        synchronized_textures.changed,
      );
      const source_width = Math.max(
        1,
        Math.round(
          frame.target_width *
            frame.plan.accumulation.presentation.quality.render_scale,
        ),
      );
      const source_height = Math.max(
        1,
        Math.round(
          frame.target_height *
            frame.plan.accumulation.presentation.quality.render_scale,
        ),
      );
      const path_targets = ensure_targets(source_width, source_height);
      const output_accumulation = (latest_accumulation === 0 ? 1 : 0) as 0 | 1;
      const accumulated_before = frame.plan.accumulation.accumulated_samples -
        frame.plan.accumulation.samples_in_frame;
      device.queue.writeBuffer(
        path_uniform,
        0,
        path_uniform_bytes(
          frame,
          source_width,
          source_height,
          accumulated_before,
        ),
      );
      device.queue.writeBuffer(
        denoise_uniform,
        0,
        new Uint32Array([
          source_width,
          source_height,
          frame.target_width,
          frame.target_height,
        ]),
      );
      const trace_bind_group = device.createBindGroup({
        layout: trace_pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: path_uniform } },
          { binding: 1, resource: { buffer: scene_buffers.triangles } },
          { binding: 2, resource: { buffer: scene_buffers.blas } },
          { binding: 3, resource: { buffer: scene_buffers.blas_indices } },
          { binding: 4, resource: { buffer: scene_buffers.geometries } },
          { binding: 5, resource: { buffer: scene_buffers.instances } },
          { binding: 6, resource: { buffer: scene_buffers.tlas } },
          { binding: 7, resource: { buffer: scene_buffers.tlas_indices } },
          { binding: 8, resource: { buffer: scene_buffers.surfaces } },
          {
            binding: 9,
            resource: path_targets.accumulation[latest_accumulation]
              .createView(),
          },
          {
            binding: 10,
            resource: path_targets.accumulation[output_accumulation]
              .createView(),
          },
          { binding: 11, resource: path_targets.depth.createView() },
          { binding: 12, resource: path_targets.normal.createView() },
          {
            binding: 13,
            resource: path_targets.moments[latest_accumulation].createView(),
          },
          {
            binding: 14,
            resource: path_targets.moments[output_accumulation].createView(),
          },
          {
            binding: 15,
            resource: texture_set.base_color_texture.createView({
              dimension: "2d-array",
            }),
          },
          {
            binding: 16,
            resource: texture_set.normal_texture.createView({
              dimension: "2d-array",
            }),
          },
          { binding: 17, resource: texture_set.sampler },
        ],
      });
      const trace_pass = frame.commands.beginComputePass();
      trace_pass.setPipeline(trace_pipeline);
      trace_pass.setBindGroup(0, trace_bind_group);
      trace_pass.dispatchWorkgroups(
        Math.ceil(source_width / 8),
        Math.ceil(source_height / 8),
      );
      trace_pass.end();

      const denoise_bind_group = device.createBindGroup({
        layout: denoise_pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: denoise_uniform } },
          {
            binding: 1,
            resource: path_targets.accumulation[output_accumulation]
              .createView(),
          },
          { binding: 2, resource: path_targets.depth.createView() },
          { binding: 3, resource: path_targets.normal.createView() },
          {
            binding: 4,
            resource: path_targets.moments[output_accumulation].createView(),
          },
          { binding: 5, resource: frame.hdr.createView() },
        ],
      });
      const denoise_pass = frame.commands.beginComputePass();
      denoise_pass.setPipeline(denoise_pipeline);
      denoise_pass.setBindGroup(0, denoise_bind_group);
      denoise_pass.dispatchWorkgroups(
        Math.ceil(frame.target_width / 8),
        Math.ceil(frame.target_height / 8),
      );
      denoise_pass.end();
      latest_accumulation = output_accumulation;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      path_uniform.destroy();
      denoise_uniform.destroy();
      destroy_scene_buffers(scene_buffers);
      destroy_targets(targets);
      destroy_path_texture_set(texture_set);
      targets = undefined;
    },
  };
}

function synchronize_scene_buffers(
  device: GPUDevice,
  current: PathTracingSceneBuffers,
  frame: TracedFramePlan,
  texture_layers: PathTracingTextureLayers,
  texture_layers_changed: boolean,
): PathTracingSceneBuffers {
  if (
    !texture_layers_changed && !Object.values(frame.uploads).some(Boolean)
  ) return current;
  const packed = pack_ray_tracing_gpu_scene(
    frame.packed_scene,
    texture_layers,
  );
  const surfaces = concatenate_bytes(packed.materials, packed.lights);
  const replacements = new Map<keyof PathTracingSceneBuffers, GPUBuffer>();
  const create_replacement = (
    key: keyof PathTracingSceneBuffers,
    bytes: Uint8Array,
  ): GPUBuffer => {
    const buffer = create_storage_buffer(device, bytes);
    replacements.set(key, buffer);
    return buffer;
  };
  let next: PathTracingSceneBuffers;
  try {
    next = {
      blas: frame.uploads.blas
        ? create_replacement("blas", packed.blas)
        : current.blas,
      blas_indices: frame.uploads.blas
        ? create_replacement("blas_indices", packed.blas_indices)
        : current.blas_indices,
      geometries: frame.uploads.geometry
        ? create_replacement("geometries", packed.geometries)
        : current.geometries,
      instances: frame.uploads.instances
        ? create_replacement("instances", packed.instances)
        : current.instances,
      surfaces: texture_layers_changed || frame.uploads.materials ||
          frame.uploads.lights
        ? create_replacement("surfaces", surfaces)
        : current.surfaces,
      triangles: frame.uploads.triangles
        ? create_replacement("triangles", packed.triangles)
        : current.triangles,
      tlas: frame.uploads.tlas
        ? create_replacement("tlas", packed.tlas)
        : current.tlas,
      tlas_indices: frame.uploads.tlas
        ? create_replacement("tlas_indices", packed.tlas_indices)
        : current.tlas_indices,
    };
  } catch (error) {
    for (const buffer of replacements.values()) buffer.destroy();
    throw error;
  }
  for (const key of replacements.keys()) current[key].destroy();
  return next;
}

function synchronize_path_texture_set(
  device: GPUDevice,
  current: PathTracingTextureSet,
  sources: readonly PathTracingTextureSource[],
): { readonly changed: boolean; readonly texture_set: PathTracingTextureSet } {
  if (same_path_texture_sources(current.sources, sources)) {
    return { changed: false, texture_set: current };
  }
  const replacement = create_path_texture_set(device, sources);
  destroy_path_texture_set(current);
  return { changed: true, texture_set: replacement };
}

function same_path_texture_sources(
  current: readonly PathTracingTextureSource[],
  next: readonly PathTracingTextureSource[],
): boolean {
  if (current.length !== next.length) return false;
  return current.every((texture, index) => {
    const candidate = next[index];
    return texture.id === candidate.id &&
      texture.color_space === candidate.color_space &&
      texture.source === candidate.source;
  });
}

function create_path_texture_set(
  device: GPUDevice,
  sources: readonly PathTracingTextureSource[],
): PathTracingTextureSet {
  let base_color: PathTracingTextureArray | undefined;
  let normal: PathTracingTextureArray | undefined;
  try {
    base_color = create_path_texture_array(
      device,
      sources.filter(({ color_space }) => color_space === "srgb"),
      "rgba8unorm-srgb",
    );
    normal = create_path_texture_array(
      device,
      sources.filter(({ color_space }) => color_space === "linear"),
      "rgba8unorm",
    );
    const sampler = device.createSampler({
      addressModeU: "repeat",
      addressModeV: "repeat",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      maxAnisotropy: 8,
    });
    return {
      base_color: base_color.layers,
      base_color_texture: base_color.texture,
      normal: normal.layers,
      normal_texture: normal.texture,
      sampler,
      sources: Object.freeze([...sources]),
    };
  } catch (error) {
    base_color?.texture.destroy();
    normal?.texture.destroy();
    throw error;
  }
}

function create_path_texture_array(
  device: GPUDevice,
  sources: readonly PathTracingTextureSource[],
  format: GPUTextureFormat,
): PathTracingTextureArray {
  const sorted_sources = [...sources].sort((left, right) =>
    compare_code_units(left.id, right.id)
  );
  const width = Math.max(
    1,
    ...sorted_sources.map(({ source }) => source.width),
  );
  const height = Math.max(
    1,
    ...sorted_sources.map(({ source }) => source.height),
  );
  const texture = device.createTexture({
    size: {
      width,
      height,
      depthOrArrayLayers: Math.max(1, sorted_sources.length),
    },
    dimension: "2d",
    format,
    usage: texture_usage.copy_dst | texture_usage.render_attachment |
      texture_usage.texture_binding,
  });
  try {
    const layers = new Map<string, PathTracingTextureLayer>();
    sorted_sources.forEach((source, layer) => {
      device.queue.copyExternalImageToTexture(
        { source: source.source },
        { origin: { x: 0, y: 0, z: layer }, texture },
        {
          width: source.source.width,
          height: source.source.height,
          depthOrArrayLayers: 1,
        },
      );
      layers.set(
        source.id,
        Object.freeze({
          layer,
          width_scale: source.source.width / width,
          height_scale: source.source.height / height,
        }),
      );
    });
    return { layers, texture };
  } catch (error) {
    texture.destroy();
    throw error;
  }
}

function destroy_path_texture_set(texture_set: PathTracingTextureSet): void {
  texture_set.base_color_texture.destroy();
  texture_set.normal_texture.destroy();
}

function create_initial_path_tracing_resources(
  device: GPUDevice,
): InitialPathTracingResources {
  let path_uniform: GPUBuffer | undefined;
  let denoise_uniform: GPUBuffer | undefined;
  let scene_buffers: PathTracingSceneBuffers | undefined;
  let texture_set: PathTracingTextureSet | undefined;
  try {
    path_uniform = device.createBuffer({
      size: 176,
      usage: buffer_usage.uniform | buffer_usage.copy_dst,
    });
    denoise_uniform = device.createBuffer({
      size: 16,
      usage: buffer_usage.uniform | buffer_usage.copy_dst,
    });
    scene_buffers = placeholder_scene_buffers(device);
    texture_set = create_path_texture_set(device, []);
    return { denoise_uniform, path_uniform, scene_buffers, texture_set };
  } catch (error) {
    path_uniform?.destroy();
    denoise_uniform?.destroy();
    if (scene_buffers !== undefined) destroy_scene_buffers(scene_buffers);
    if (texture_set !== undefined) destroy_path_texture_set(texture_set);
    throw error;
  }
}

function placeholder_scene_buffers(device: GPUDevice): PathTracingSceneBuffers {
  const buffers: GPUBuffer[] = [];
  const create_placeholder = (): GPUBuffer => {
    const buffer = create_storage_buffer(device, new Uint8Array());
    buffers.push(buffer);
    return buffer;
  };
  try {
    return {
      blas: create_placeholder(),
      blas_indices: create_placeholder(),
      geometries: create_placeholder(),
      instances: create_placeholder(),
      surfaces: create_placeholder(),
      triangles: create_placeholder(),
      tlas: create_placeholder(),
      tlas_indices: create_placeholder(),
    };
  } catch (error) {
    for (const buffer of buffers) buffer.destroy();
    throw error;
  }
}

function create_storage_buffer(
  device: GPUDevice,
  bytes: Uint8Array,
): GPUBuffer {
  const buffer = device.createBuffer({
    size: Math.max(4, bytes.byteLength),
    usage: buffer_usage.storage,
    mappedAtCreation: true,
  });
  try {
    new Uint8Array(buffer.getMappedRange()).set(bytes);
    buffer.unmap();
    return buffer;
  } catch (error) {
    buffer.destroy();
    throw error;
  }
}

function path_uniform_bytes(
  frame: PathTracingComputeFrame,
  width: number,
  height: number,
  accumulated_before: number,
): Uint8Array {
  const bytes = new Uint8Array(176);
  const view = new DataView(bytes.buffer);
  write_f32_array(view, 0, frame.inverse_view_projection);
  write_f32_array(view, 64, [
    frame.camera_position.x,
    frame.camera_position.y,
    frame.camera_position.z,
    0,
  ]);
  write_f32_array(view, 80, [
    frame.clear_color.r,
    frame.clear_color.g,
    frame.clear_color.b,
    frame.clear_color.a,
  ]);
  write_f32_array(view, 96, [
    frame.ambient_light.r,
    frame.ambient_light.g,
    frame.ambient_light.b,
    frame.fog_density,
  ]);
  write_f32_array(view, 112, [
    frame.fog_color.r,
    frame.fog_color.g,
    frame.fog_color.b,
    0,
  ]);
  write_u32_array(view, 128, [
    width,
    height,
    frame.plan.accumulation.samples_in_frame,
    frame.plan.accumulation.presentation.quality.maximum_bounces,
  ]);
  write_u32_array(view, 144, [
    frame.plan.packed_scene.instances.length,
    frame.plan.packed_scene.lights.length,
    frame.plan.packed_scene.tlas_root ?? missing_node,
    accumulated_before,
  ]);
  write_u32_array(view, 160, [
    frame.plan.accumulation.sample_sequence,
    frame.plan.packed_scene.materials.length,
    0,
    0,
  ]);
  return bytes;
}

function create_path_targets(
  device: GPUDevice,
  width: number,
  height: number,
): PathTracingTargets {
  const textures: GPUTexture[] = [];
  const create_target = (format: GPUTextureFormat): GPUTexture => {
    const texture = create_path_texture(device, width, height, format);
    textures.push(texture);
    return texture;
  };
  try {
    return {
      accumulation: [
        create_target("rgba16float"),
        create_target("rgba16float"),
      ],
      depth: create_target("r32float"),
      height,
      moments: [
        create_target("rgba16float"),
        create_target("rgba16float"),
      ],
      normal: create_target("rgba16float"),
      width,
    };
  } catch (error) {
    for (const texture of textures) texture.destroy();
    throw error;
  }
}

function create_path_texture(
  device: GPUDevice,
  width: number,
  height: number,
  format: GPUTextureFormat,
): GPUTexture {
  return device.createTexture({
    size: [width, height],
    format,
    usage: texture_usage.texture_binding | texture_usage.storage_binding,
  });
}

function concatenate_bytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const combined = new Uint8Array(first.byteLength + second.byteLength);
  combined.set(first);
  combined.set(second, first.byteLength);
  return combined;
}

function destroy_scene_buffers(buffers: PathTracingSceneBuffers): void {
  buffers.blas.destroy();
  buffers.blas_indices.destroy();
  buffers.geometries.destroy();
  buffers.instances.destroy();
  buffers.surfaces.destroy();
  buffers.triangles.destroy();
  buffers.tlas.destroy();
  buffers.tlas_indices.destroy();
}

function destroy_targets(targets: PathTracingTargets | undefined): void {
  if (targets === undefined) return;
  targets.accumulation[0].destroy();
  targets.accumulation[1].destroy();
  targets.moments[0].destroy();
  targets.moments[1].destroy();
  targets.depth.destroy();
  targets.normal.destroy();
}

function write_f32_array(
  view: DataView,
  offset: number,
  values: readonly number[],
): void {
  for (const [index, value] of values.entries()) {
    view.setFloat32(offset + index * 4, value, true);
  }
}

function write_u32_array(
  view: DataView,
  offset: number,
  values: readonly number[],
): void {
  for (const [index, value] of values.entries()) {
    view.setUint32(offset + index * 4, value, true);
  }
}

function compare_code_units(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
