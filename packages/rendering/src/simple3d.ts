import { mat4_multiply } from "@ink/math/matrix.ts";
import {
  look_at_view,
  orthographic_projection,
  perspective_projection,
} from "@ink/math/projection.ts";
import { vec3 } from "@ink/math/vector.ts";
import {
  simple3d_post_shader,
  simple3d_scene_shader,
  simple3d_shadow_shader,
} from "./simple3d_wgsl.ts";

export type Simple3dVector = readonly [number, number, number];
export type Simple3dBuiltInShape = "cube" | "plane" | "sphere";
export type Simple3dMeshId = string & { readonly __brand: "Simple3dMeshId" };
export type Simple3dTextureId = string & {
  readonly __brand: "Simple3dTextureId";
};

export interface Simple3dMaterial {
  readonly albedo: Simple3dVector;
  readonly emissive: Simple3dVector;
  readonly metallic: number;
  readonly roughness: number;
}

interface Simple3dObjectProperties {
  readonly id: string;
  readonly position: Simple3dVector;
  readonly rotation_y_radians: number;
  readonly scale: Simple3dVector;
  readonly material: Simple3dMaterial;
}

export type Simple3dObject =
  & Simple3dObjectProperties
  & (
    | { readonly shape: Simple3dBuiltInShape }
    | { readonly shape: "mesh"; readonly mesh: Simple3dMeshId }
  );

export interface Simple3dMesh {
  readonly base_color_texture?: Simple3dTextureId;
  readonly id: Simple3dMeshId;
  readonly indices: Uint32Array;
  readonly normal_texture?: Simple3dTextureId;
  readonly vertices: Float32Array;
}

export interface Simple3dTexture {
  readonly color_space: "linear" | "srgb";
  readonly id: Simple3dTextureId;
  readonly source: ImageBitmap;
}

export interface Simple3dCamera {
  readonly position: Simple3dVector;
  readonly target: Simple3dVector;
  readonly vertical_fov_radians: number;
}

export interface Simple3dDirectionalLight {
  readonly color: Simple3dVector;
  readonly direction: Simple3dVector;
  readonly intensity: number;
}

export interface Simple3dPointLight {
  readonly color: Simple3dVector;
  readonly position: Simple3dVector;
  readonly intensity: number;
  readonly range: number;
}

export interface Simple3dSpotLight extends Simple3dPointLight {
  readonly direction: Simple3dVector;
  readonly outer_angle_radians: number;
}

export interface Simple3dScene {
  readonly camera: Simple3dCamera;
  readonly clear_color: Simple3dVector;
  readonly ambient_color: Simple3dVector;
  readonly directional_light: Simple3dDirectionalLight;
  readonly point_lights: readonly Simple3dPointLight[];
  readonly spot_lights: readonly Simple3dSpotLight[];
  readonly fog_color: Simple3dVector;
  readonly fog_density: number;
  readonly exposure: number;
  readonly bloom_intensity: number;
  readonly meshes: readonly Simple3dMesh[];
  readonly textures: readonly Simple3dTexture[];
  readonly objects: readonly Simple3dObject[];
}

export interface Simple3dRenderer {
  readonly adapter_description: string;
  readonly validation_error_count: number;
  render(scene: Simple3dScene): void;
  dispose(): void;
}

const gpu_buffer_usage = {
  copy_dst: 0x08,
  index: 0x10,
  uniform: 0x40,
  vertex: 0x20,
} as const;
const gpu_texture_usage = {
  copy_dst: 0x02,
  render_attachment: 0x10,
  texture_binding: 0x04,
} as const;
const instance_float_count = 24;
const maximum_point_lights = 4;
const maximum_spot_lights = 2;
const shadow_map_size = 2048;
const validated_vertex_arrays = new WeakSet<Float32Array>();
const validated_index_arrays = new WeakSet<Uint32Array>();

interface ShapeGeometry {
  readonly first_vertex: number;
  readonly vertex_count: number;
}

interface ImportedGeometry {
  readonly base_color_texture?: Simple3dTextureId;
  readonly base_vertex: number;
  readonly first_index: number;
  readonly index_count: number;
  readonly normal_texture?: Simple3dTextureId;
}

interface ImportedTexture {
  readonly color_space: Simple3dTexture["color_space"];
  readonly source: ImageBitmap;
  readonly texture: GPUTexture;
}

interface ImportedGeometrySet {
  readonly index_buffer: GPUBuffer;
  readonly meshes: readonly Simple3dMesh[];
  readonly ranges: ReadonlyMap<Simple3dMeshId, ImportedGeometry>;
  readonly vertex_buffer: GPUBuffer;
}

type ShapeKey = Simple3dBuiltInShape | Simple3dMeshId;
const built_in_shapes = ["cube", "plane", "sphere"] as const;

export function simple3d_mesh_id(value: string): Simple3dMeshId {
  if (value.trim() === "") throw new Error("simple 3D mesh id cannot be empty");
  return value as Simple3dMeshId;
}

export function simple3d_texture_id(value: string): Simple3dTextureId {
  if (value.trim() === "") {
    throw new Error("simple 3D texture id cannot be empty");
  }
  return value as Simple3dTextureId;
}

export async function create_simple3d_renderer(
  canvas: HTMLCanvasElement,
): Promise<Simple3dRenderer> {
  if (!navigator.gpu) throw new Error("WebGPU is unavailable");
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
    forceFallbackAdapter: false,
  });
  if (adapter === null) throw new Error("no WebGPU adapter is available");
  if (adapter.info.isFallbackAdapter) {
    throw new Error("the WebGPU adapter is a software fallback");
  }
  const device = await adapter.requestDevice();
  const rendering_context = canvas.getContext("webgpu");
  if (!is_gpu_canvas_context(rendering_context)) {
    device.destroy();
    throw new Error("the canvas did not provide a WebGPU context");
  }
  const context = rendering_context;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const scene_module = device.createShaderModule({
    code: simple3d_scene_shader,
  });
  const shadow_module = device.createShaderModule({
    code: simple3d_shadow_shader,
  });
  const post_module = device.createShaderModule({ code: simple3d_post_shader });
  const shader_messages = await Promise.all([
    scene_module.getCompilationInfo(),
    shadow_module.getCompilationInfo(),
    post_module.getCompilationInfo(),
  ]);
  const shader_errors = shader_messages.flatMap(({ messages }) =>
    [...messages].filter(({ type }) => type === "error")
  );
  if (shader_errors.length > 0) {
    context.unconfigure();
    device.destroy();
    throw new Error(
      `simple 3D shader failed: ${
        shader_errors.map(({ message }) => message).join("; ")
      }`,
    );
  }

  const instance_layout: GPUVertexBufferLayout = {
    arrayStride: instance_float_count * 4,
    stepMode: "instance",
    attributes: [
      { shaderLocation: 2, offset: 0, format: "float32x4" },
      { shaderLocation: 3, offset: 16, format: "float32x4" },
      { shaderLocation: 4, offset: 32, format: "float32x4" },
      { shaderLocation: 5, offset: 48, format: "float32x4" },
      { shaderLocation: 6, offset: 64, format: "float32x4" },
      { shaderLocation: 7, offset: 80, format: "float32x4" },
    ],
  };
  const geometry_layout: GPUVertexBufferLayout = {
    arrayStride: 32,
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x3" },
      { shaderLocation: 1, offset: 12, format: "float32x3" },
      { shaderLocation: 8, offset: 24, format: "float32x2" },
    ],
  };

  const scene_pipeline = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: {
      module: scene_module,
      entryPoint: "vertex_main",
      buffers: [geometry_layout, instance_layout],
    },
    fragment: {
      module: scene_module,
      entryPoint: "fragment_main",
      targets: [{ format: "rgba16float" }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less",
    },
  });
  const shadow_pipeline = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: {
      module: shadow_module,
      entryPoint: "vertex_main",
      buffers: [geometry_layout, instance_layout],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: true,
      depthCompare: "less",
      depthBias: 2,
      depthBiasSlopeScale: 2,
    },
  });
  const post_pipeline = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: { module: post_module, entryPoint: "vertex_main" },
    fragment: {
      module: post_module,
      entryPoint: "fragment_main",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list" },
  });

  const geometry = build_geometry();
  const geometry_buffer = create_buffer(
    device,
    geometry.vertices,
    gpu_buffer_usage.vertex,
  );
  let imported_geometry = create_imported_geometry_set(device, []);
  const imported_textures = new Map<Simple3dTextureId, ImportedTexture>();
  const material_sampler = device.createSampler({
    addressModeU: "repeat",
    addressModeV: "repeat",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
  });
  const fallback_material_textures = create_fallback_material_textures(device);
  const material_bind_group_layout = scene_pipeline.getBindGroupLayout(1);
  const fallback_material_bind_group = create_material_bind_group(
    device,
    material_bind_group_layout,
    material_sampler,
    fallback_material_textures.base_color,
    fallback_material_textures.normal,
  );
  const material_bind_groups = new Map<string, GPUBindGroup>();
  let instance_buffer = device.createBuffer({
    size: instance_float_count * 4,
    usage: gpu_buffer_usage.vertex | gpu_buffer_usage.copy_dst,
  });
  let instance_capacity = 1;
  const frame_buffer = device.createBuffer({
    size: frame_uniform_float_count() * 4,
    usage: gpu_buffer_usage.uniform | gpu_buffer_usage.copy_dst,
  });
  const shadow_buffer = device.createBuffer({
    size: 16 * 4,
    usage: gpu_buffer_usage.uniform | gpu_buffer_usage.copy_dst,
  });
  const post_buffer = device.createBuffer({
    size: 16,
    usage: gpu_buffer_usage.uniform | gpu_buffer_usage.copy_dst,
  });
  const shadow_texture = device.createTexture({
    size: [shadow_map_size, shadow_map_size],
    format: "depth32float",
    usage: gpu_texture_usage.render_attachment |
      gpu_texture_usage.texture_binding,
  });
  const shadow_sampler = device.createSampler({
    compare: "less-equal",
    magFilter: "linear",
    minFilter: "linear",
  });
  const scene_bind_group = device.createBindGroup({
    layout: scene_pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frame_buffer } },
      { binding: 1, resource: shadow_texture.createView() },
      { binding: 2, resource: shadow_sampler },
    ],
  });
  const shadow_bind_group = device.createBindGroup({
    layout: shadow_pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: shadow_buffer } }],
  });
  const hdr_sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });
  let depth_texture: GPUTexture | undefined;
  let hdr_texture: GPUTexture | undefined;
  let post_bind_group: GPUBindGroup | undefined;
  let render_width = 0;
  let render_height = 0;
  let validation_error_count = 0;
  let disposed = false;
  let device_failure: string | undefined;
  let synchronized_textures: readonly Simple3dTexture[] = [];
  let batched_objects: readonly Simple3dObject[] = [];
  let batches = scene_instances([]);

  const report_uncaptured_error = (event: GPUUncapturedErrorEvent) => {
    validation_error_count += 1;
    device_failure = `uncaptured WebGPU error: ${event.error.message}`;
  };
  device.addEventListener("uncapturederror", report_uncaptured_error);
  void device.lost.then(({ message, reason }) => {
    if (!disposed) {
      device_failure = `WebGPU device lost (${reason}): ${message}`;
    }
  });

  function ensure_targets(): void {
    const pixel_ratio = Math.max(1, globalThis.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(canvas.clientWidth * pixel_ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * pixel_ratio));
    if (width === render_width && height === render_height) return;
    render_width = width;
    render_height = height;
    canvas.width = width;
    canvas.height = height;
    depth_texture?.destroy();
    hdr_texture?.destroy();
    depth_texture = device.createTexture({
      size: [width, height],
      format: "depth24plus",
      usage: gpu_texture_usage.render_attachment,
    });
    hdr_texture = device.createTexture({
      size: [width, height],
      format: "rgba16float",
      usage: gpu_texture_usage.render_attachment |
        gpu_texture_usage.texture_binding,
    });
    post_bind_group = device.createBindGroup({
      layout: post_pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: hdr_texture.createView() },
        { binding: 1, resource: hdr_sampler },
        { binding: 2, resource: { buffer: post_buffer } },
      ],
    });
  }

  return {
    adapter_description: adapter.info.description || adapter.info.vendor ||
      "WebGPU adapter",
    get validation_error_count() {
      return validation_error_count;
    },
    render(scene) {
      if (disposed) throw new Error("simple 3D renderer is disposed");
      if (device_failure !== undefined) throw new Error(device_failure);
      validate_simple3d_scene(scene);
      ensure_targets();
      if (imported_geometry.meshes !== scene.meshes) {
        imported_geometry.vertex_buffer.destroy();
        imported_geometry.index_buffer.destroy();
        imported_geometry = create_imported_geometry_set(
          device,
          scene.meshes,
        );
      }
      if (synchronized_textures !== scene.textures) {
        synchronize_imported_textures(
          device,
          imported_textures,
          scene.textures,
        );
        synchronized_textures = scene.textures;
        material_bind_groups.clear();
      }
      if (batched_objects !== scene.objects) {
        batches = scene_instances(scene.objects);
        batched_objects = scene.objects;
        const instance_count = batches.values.length / instance_float_count;
        if (instance_count > instance_capacity) {
          instance_buffer.destroy();
          instance_capacity = next_power_of_two(instance_count);
          instance_buffer = device.createBuffer({
            size: instance_capacity * instance_float_count * 4,
            usage: gpu_buffer_usage.vertex | gpu_buffer_usage.copy_dst,
          });
        }
        if (batches.values.length > 0) {
          device.queue.writeBuffer(instance_buffer, 0, batches.values);
        }
      }
      const light_view_projection = light_matrix(
        scene.directional_light.direction,
        scene.camera,
      );
      device.queue.writeBuffer(
        frame_buffer,
        0,
        frame_uniform(
          scene,
          render_width,
          render_height,
          light_view_projection,
        ),
      );
      device.queue.writeBuffer(
        shadow_buffer,
        0,
        new Float32Array(light_view_projection),
      );
      device.queue.writeBuffer(
        post_buffer,
        0,
        new Float32Array([
          scene.exposure,
          scene.bloom_intensity,
          1 / render_width,
          1 / render_height,
        ]),
      );

      const commands = device.createCommandEncoder();
      const shadow_pass = commands.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: shadow_texture.createView(),
          depthClearValue: 1,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      shadow_pass.setPipeline(shadow_pipeline);
      shadow_pass.setBindGroup(0, shadow_bind_group);
      draw_batches(
        shadow_pass,
        geometry,
        geometry_buffer,
        imported_geometry,
        instance_buffer,
        batches.ranges,
        undefined,
      );
      shadow_pass.end();

      const scene_pass = commands.beginRenderPass({
        colorAttachments: [{
          view: hdr_texture!.createView(),
          clearValue: {
            r: scene.clear_color[0],
            g: scene.clear_color[1],
            b: scene.clear_color[2],
            a: 1,
          },
          loadOp: "clear",
          storeOp: "store",
        }],
        depthStencilAttachment: {
          view: depth_texture!.createView(),
          depthClearValue: 1,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      scene_pass.setPipeline(scene_pipeline);
      scene_pass.setBindGroup(0, scene_bind_group);
      draw_batches(
        scene_pass,
        geometry,
        geometry_buffer,
        imported_geometry,
        instance_buffer,
        batches.ranges,
        {
          fallback: fallback_material_bind_group,
          bind_groups: material_bind_groups,
          device,
          fallback_textures: fallback_material_textures,
          layout: material_bind_group_layout,
          sampler: material_sampler,
          textures: imported_textures,
        },
      );
      scene_pass.end();

      const post_pass = commands.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      post_pass.setPipeline(post_pipeline);
      post_pass.setBindGroup(0, post_bind_group!);
      post_pass.draw(3);
      post_pass.end();
      device.queue.submit([commands.finish()]);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      device.removeEventListener("uncapturederror", report_uncaptured_error);
      geometry_buffer.destroy();
      imported_geometry.vertex_buffer.destroy();
      imported_geometry.index_buffer.destroy();
      for (const imported of imported_textures.values()) {
        imported.texture.destroy();
      }
      imported_textures.clear();
      fallback_material_textures.base_color.destroy();
      fallback_material_textures.normal.destroy();
      instance_buffer.destroy();
      frame_buffer.destroy();
      shadow_buffer.destroy();
      post_buffer.destroy();
      shadow_texture.destroy();
      depth_texture?.destroy();
      hdr_texture?.destroy();
      context.unconfigure();
      device.destroy();
    },
  };
}

function draw_batches(
  pass: GPURenderPassEncoder,
  geometry: ReturnType<typeof build_geometry>,
  geometry_buffer: GPUBuffer,
  imported_geometry: ImportedGeometrySet,
  instance_buffer: GPUBuffer,
  ranges: ReadonlyMap<
    ShapeKey,
    { readonly first: number; readonly count: number }
  >,
  materials:
    | {
      readonly bind_groups: Map<string, GPUBindGroup>;
      readonly device: GPUDevice;
      readonly fallback: GPUBindGroup;
      readonly fallback_textures: {
        readonly base_color: GPUTexture;
        readonly normal: GPUTexture;
      };
      readonly layout: GPUBindGroupLayout;
      readonly sampler: GPUSampler;
      readonly textures: ReadonlyMap<Simple3dTextureId, ImportedTexture>;
    }
    | undefined,
): void {
  pass.setVertexBuffer(1, instance_buffer);
  for (const [shape, range] of ranges) {
    if (range.count === 0) continue;
    if (is_built_in_shape(shape)) {
      const shape_geometry = geometry.shapes.get(shape);
      if (shape_geometry === undefined) {
        throw new Error(
          `simple 3D renderer omitted built-in ${shape} geometry`,
        );
      }
      pass.setVertexBuffer(0, geometry_buffer);
      if (materials !== undefined) pass.setBindGroup(1, materials.fallback);
      pass.draw(
        shape_geometry.vertex_count,
        range.count,
        shape_geometry.first_vertex,
        range.first,
      );
      continue;
    }
    const imported = imported_geometry.ranges.get(shape);
    if (imported === undefined) {
      throw new Error(
        `simple 3D renderer omitted imported mesh ${JSON.stringify(shape)}`,
      );
    }
    pass.setVertexBuffer(0, imported_geometry.vertex_buffer);
    pass.setIndexBuffer(imported_geometry.index_buffer, "uint32");
    if (materials !== undefined) {
      pass.setBindGroup(
        1,
        material_bind_group(materials, imported),
      );
    }
    pass.drawIndexed(
      imported.index_count,
      range.count,
      imported.first_index,
      imported.base_vertex,
      range.first,
    );
  }
}

function material_bind_group(
  materials: {
    readonly bind_groups: Map<string, GPUBindGroup>;
    readonly device: GPUDevice;
    readonly fallback: GPUBindGroup;
    readonly fallback_textures: {
      readonly base_color: GPUTexture;
      readonly normal: GPUTexture;
    };
    readonly layout: GPUBindGroupLayout;
    readonly sampler: GPUSampler;
    readonly textures: ReadonlyMap<Simple3dTextureId, ImportedTexture>;
  },
  geometry: ImportedGeometry,
): GPUBindGroup {
  if (
    geometry.base_color_texture === undefined &&
    geometry.normal_texture === undefined
  ) return materials.fallback;
  const key = `${geometry.base_color_texture ?? ""}|${
    geometry.normal_texture ?? ""
  }`;
  const cached = materials.bind_groups.get(key);
  if (cached !== undefined) return cached;
  const base_color = geometry.base_color_texture === undefined
    ? undefined
    : materials.textures.get(geometry.base_color_texture);
  const normal = geometry.normal_texture === undefined
    ? undefined
    : materials.textures.get(geometry.normal_texture);
  const bind_group = create_material_bind_group(
    materials.device,
    materials.layout,
    materials.sampler,
    base_color?.texture ?? materials.fallback_textures.base_color,
    normal?.texture ?? materials.fallback_textures.normal,
  );
  materials.bind_groups.set(key, bind_group);
  return bind_group;
}

function scene_instances(objects: readonly Simple3dObject[]): {
  readonly values: Float32Array;
  readonly ranges: ReadonlyMap<
    ShapeKey,
    { readonly first: number; readonly count: number }
  >;
} {
  const grouped = new Map<ShapeKey, Simple3dObject[]>();
  for (const shape of built_in_shapes) grouped.set(shape, []);
  for (const object of objects) {
    const shape = object_shape_key(object);
    const matching = grouped.get(shape);
    if (matching === undefined) grouped.set(shape, [object]);
    else matching.push(object);
  }
  const imported_shapes = [...grouped.keys()].filter((shape) =>
    !is_built_in_shape(shape)
  ).sort();
  const shapes: readonly ShapeKey[] = [...built_in_shapes, ...imported_shapes];
  const values = new Float32Array(objects.length * instance_float_count);
  const ranges = new Map<
    ShapeKey,
    { readonly first: number; readonly count: number }
  >();
  let first = 0;
  for (const shape of shapes) {
    const matching = grouped.get(shape) ?? [];
    ranges.set(shape, { first, count: matching.length });
    for (const [index, object] of matching.entries()) {
      const offset = (first + index) * instance_float_count;
      values.set(model_matrix(object), offset);
      values.set(
        [...object.material.albedo, object.material.roughness],
        offset + 16,
      );
      values.set(
        [...object.material.emissive, object.material.metallic],
        offset + 20,
      );
    }
    first += matching.length;
  }
  return { values, ranges };
}

function model_matrix(object: Simple3dObject): readonly number[] {
  const [scale_x, scale_y, scale_z] = object.scale;
  const cosine = Math.cos(object.rotation_y_radians);
  const sine = Math.sin(object.rotation_y_radians);
  return [
    cosine * scale_x,
    0,
    -sine * scale_x,
    0,
    0,
    scale_y,
    0,
    0,
    sine * scale_z,
    0,
    cosine * scale_z,
    0,
    ...object.position,
    1,
  ];
}

function frame_uniform(
  scene: Simple3dScene,
  width: number,
  height: number,
  light_view_projection: readonly number[],
): Float32Array {
  const view = look_at_view(
    vec3(...scene.camera.position),
    vec3(...scene.camera.target),
    vec3(0, 1, 0),
  );
  const projection = perspective_projection({
    vertical_fov_radians: scene.camera.vertical_fov_radians,
    aspect_ratio: width / height,
    near_plane: 0.05,
    far_plane: 200,
  });
  const values = [
    ...mat4_multiply(projection, view),
    ...light_view_projection,
    ...scene.camera.position,
    scene.exposure,
    ...scene.ambient_color,
    scene.fog_density,
    ...scene.fog_color,
    1,
    ...scene.directional_light.direction,
    scene.directional_light.intensity,
    ...scene.directional_light.color,
    0,
  ];
  for (let index = 0; index < maximum_point_lights; index += 1) {
    const light = scene.point_lights[index];
    values.push(
      ...(light === undefined
        ? [0, 0, 0, 0]
        : [...light.position, light.range]),
    );
  }
  for (let index = 0; index < maximum_point_lights; index += 1) {
    const light = scene.point_lights[index];
    values.push(
      ...(light === undefined
        ? [0, 0, 0, 0]
        : [...light.color, light.intensity]),
    );
  }
  for (let index = 0; index < maximum_spot_lights; index += 1) {
    const light = scene.spot_lights[index];
    values.push(
      ...(light === undefined
        ? [0, 0, 0, 0]
        : [...light.position, light.range]),
    );
  }
  for (let index = 0; index < maximum_spot_lights; index += 1) {
    const light = scene.spot_lights[index];
    values.push(
      ...(light === undefined
        ? [0, 0, 0, 0]
        : [...light.direction, Math.cos(light.outer_angle_radians)]),
    );
  }
  for (let index = 0; index < maximum_spot_lights; index += 1) {
    const light = scene.spot_lights[index];
    values.push(
      ...(light === undefined
        ? [0, 0, 0, 0]
        : [...light.color, light.intensity]),
    );
  }
  return new Float32Array(values);
}

function frame_uniform_float_count(): number {
  return 16 + 16 + 4 * 5 + maximum_point_lights * 8 + maximum_spot_lights * 12;
}

function light_matrix(
  direction: Simple3dVector,
  camera: Simple3dCamera,
): readonly number[] {
  const length = Math.hypot(...direction);
  const normalized: Simple3dVector = length === 0
    ? [0.4, -1, 0.3]
    : [direction[0] / length, direction[1] / length, direction[2] / length];
  const view_distance = Math.hypot(
    camera.position[0] - camera.target[0],
    camera.position[1] - camera.target[1],
    camera.position[2] - camera.target[2],
  );
  const extent = Math.min(180, Math.max(24, view_distance * 1.3));
  const eye = vec3(
    camera.target[0] - normalized[0] * extent * 2,
    camera.target[1] - normalized[1] * extent * 2,
    camera.target[2] - normalized[2] * extent * 2,
  );
  const view = look_at_view(eye, vec3(...camera.target), vec3(0, 1, 0));
  const projection = orthographic_projection({
    left: -extent,
    right: extent,
    bottom: -extent,
    top: extent,
    near_plane: 0.1,
    far_plane: extent * 4,
  });
  return mat4_multiply(projection, view);
}

export function validate_simple3d_scene(scene: Simple3dScene): void {
  if (scene.point_lights.length > maximum_point_lights) {
    throw new Error(
      `simple 3D scene has ${scene.point_lights.length} point lights; maximum is ${maximum_point_lights}`,
    );
  }
  if (scene.spot_lights.length > maximum_spot_lights) {
    throw new Error(
      `simple 3D scene has ${scene.spot_lights.length} spot lights; maximum is ${maximum_spot_lights}`,
    );
  }
  const ids = new Set<string>();
  const mesh_ids = new Set<Simple3dMeshId>();
  const texture_ids = new Set<Simple3dTextureId>();
  for (const texture of scene.textures) {
    if (texture_ids.has(texture.id)) {
      throw new Error(
        `simple 3D scene repeats texture id ${JSON.stringify(texture.id)}`,
      );
    }
    texture_ids.add(texture.id);
    if (texture.source.width <= 0 || texture.source.height <= 0) {
      throw new Error(
        `simple 3D texture ${JSON.stringify(texture.id)} has empty dimensions`,
      );
    }
  }
  for (const mesh of scene.meshes) {
    if (mesh_ids.has(mesh.id)) {
      throw new Error(
        `simple 3D scene repeats mesh id ${JSON.stringify(mesh.id)}`,
      );
    }
    mesh_ids.add(mesh.id);
    if (mesh.vertices.length === 0 || mesh.vertices.length % 8 !== 0) {
      throw new Error(
        `simple 3D mesh ${
          JSON.stringify(mesh.id)
        } has ${mesh.vertices.length} floats; expected positive position-normal-texture vertices`,
      );
    }
    if (mesh.indices.length === 0 || mesh.indices.length % 3 !== 0) {
      throw new Error(
        `simple 3D mesh ${
          JSON.stringify(mesh.id)
        } has ${mesh.indices.length} indices; expected a non-empty triangle list`,
      );
    }
    if (
      mesh.base_color_texture !== undefined &&
      !texture_ids.has(mesh.base_color_texture)
    ) {
      throw new Error(
        `simple 3D mesh ${JSON.stringify(mesh.id)} selects missing texture ${
          JSON.stringify(mesh.base_color_texture)
        }`,
      );
    }
    if (
      mesh.normal_texture !== undefined &&
      !texture_ids.has(mesh.normal_texture)
    ) {
      throw new Error(
        `simple 3D mesh ${JSON.stringify(mesh.id)} selects missing texture ${
          JSON.stringify(mesh.normal_texture)
        }`,
      );
    }
    if (!validated_vertex_arrays.has(mesh.vertices)) {
      for (const value of mesh.vertices) {
        if (!Number.isFinite(value)) {
          throw new Error(
            `simple 3D mesh ${
              JSON.stringify(mesh.id)
            } contains non-finite vertex ${value}`,
          );
        }
      }
      validated_vertex_arrays.add(mesh.vertices);
    }
    if (validated_index_arrays.has(mesh.indices)) continue;
    const vertex_count = mesh.vertices.length / 8;
    for (const index of mesh.indices) {
      if (index >= vertex_count) {
        throw new Error(
          `simple 3D mesh ${JSON.stringify(mesh.id)} index ${index} exceeds ${
            vertex_count - 1
          }`,
        );
      }
    }
    validated_index_arrays.add(mesh.indices);
  }
  for (const object of scene.objects) {
    if (ids.has(object.id)) {
      throw new Error(
        `simple 3D scene repeats object id ${JSON.stringify(object.id)}`,
      );
    }
    ids.add(object.id);
    if (object.shape === "mesh" && !mesh_ids.has(object.mesh)) {
      throw new Error(
        `simple 3D object ${JSON.stringify(object.id)} selects missing mesh ${
          JSON.stringify(object.mesh)
        }`,
      );
    }
    for (
      const [label, value] of [
        ["roughness", object.material.roughness],
        ["metallic", object.material.metallic],
      ] as const
    ) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(
          `simple 3D object ${
            JSON.stringify(object.id)
          } ${label} ${value} must be in [0, 1]`,
        );
      }
    }
  }
}

function create_buffer(
  device: GPUDevice,
  values: Float32Array,
  usage: number,
): GPUBuffer {
  const buffer = device.createBuffer({
    size: Math.max(4, values.byteLength),
    usage,
    mappedAtCreation: true,
  });
  new Float32Array(buffer.getMappedRange()).set(values);
  buffer.unmap();
  return buffer;
}

function create_fallback_material_textures(device: GPUDevice): {
  readonly base_color: GPUTexture;
  readonly normal: GPUTexture;
} {
  return {
    base_color: create_solid_texture(
      device,
      "rgba8unorm-srgb",
      new Uint8Array([255, 255, 255, 255]),
    ),
    normal: create_solid_texture(
      device,
      "rgba8unorm",
      new Uint8Array([128, 128, 255, 255]),
    ),
  };
}

function create_solid_texture(
  device: GPUDevice,
  format: GPUTextureFormat,
  color: Uint8Array,
): GPUTexture {
  const texture = device.createTexture({
    size: [1, 1],
    format,
    usage: gpu_texture_usage.copy_dst | gpu_texture_usage.texture_binding,
  });
  device.queue.writeTexture(
    { texture },
    color,
    { bytesPerRow: 4 },
    [1, 1],
  );
  return texture;
}

function create_material_bind_group(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  sampler: GPUSampler,
  base_color: GPUTexture,
  normal: GPUTexture,
): GPUBindGroup {
  return device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: base_color.createView() },
      { binding: 1, resource: sampler },
      { binding: 2, resource: normal.createView() },
      { binding: 3, resource: sampler },
    ],
  });
}

function is_gpu_canvas_context(
  context: RenderingContext | null,
): context is GPUCanvasContext {
  return context !== null &&
    "configure" in context && typeof context.configure === "function" &&
    "unconfigure" in context && typeof context.unconfigure === "function" &&
    "getCurrentTexture" in context &&
    typeof context.getCurrentTexture === "function";
}

function next_power_of_two(value: number): number {
  let capacity = 1;
  while (capacity < value) capacity *= 2;
  return capacity;
}

function build_geometry(): {
  readonly vertices: Float32Array;
  readonly shapes: ReadonlyMap<Simple3dBuiltInShape, ShapeGeometry>;
} {
  const cube = append_zero_texture_coordinates(cube_vertices());
  const plane = append_zero_texture_coordinates(plane_vertices());
  const sphere = append_zero_texture_coordinates(sphere_vertices(20, 12));
  return {
    vertices: new Float32Array([...cube, ...plane, ...sphere]),
    shapes: new Map([
      ["cube", { first_vertex: 0, vertex_count: cube.length / 8 }],
      ["plane", {
        first_vertex: cube.length / 8,
        vertex_count: plane.length / 8,
      }],
      ["sphere", {
        first_vertex: (cube.length + plane.length) / 8,
        vertex_count: sphere.length / 8,
      }],
    ]),
  };
}

function create_imported_geometry_set(
  device: GPUDevice,
  meshes: readonly Simple3dMesh[],
): ImportedGeometrySet {
  const vertex_float_count = meshes.reduce(
    (count, mesh) => count + mesh.vertices.length,
    0,
  );
  const index_count = meshes.reduce(
    (count, mesh) => count + mesh.indices.length,
    0,
  );
  const vertex_buffer = device.createBuffer({
    size: Math.max(4, vertex_float_count * 4),
    usage: gpu_buffer_usage.vertex,
    mappedAtCreation: true,
  });
  const index_buffer = device.createBuffer({
    size: Math.max(4, index_count * 4),
    usage: gpu_buffer_usage.index,
    mappedAtCreation: true,
  });
  const vertices = new Float32Array(vertex_buffer.getMappedRange());
  const indices = new Uint32Array(index_buffer.getMappedRange());
  const ranges = new Map<Simple3dMeshId, ImportedGeometry>();
  let vertex_offset = 0;
  let index_offset = 0;
  for (const mesh of meshes) {
    vertices.set(mesh.vertices, vertex_offset);
    indices.set(mesh.indices, index_offset);
    ranges.set(mesh.id, {
      ...(mesh.base_color_texture === undefined
        ? {}
        : { base_color_texture: mesh.base_color_texture }),
      base_vertex: vertex_offset / 8,
      first_index: index_offset,
      index_count: mesh.indices.length,
      ...(mesh.normal_texture === undefined
        ? {}
        : { normal_texture: mesh.normal_texture }),
    });
    vertex_offset += mesh.vertices.length;
    index_offset += mesh.indices.length;
  }
  vertex_buffer.unmap();
  index_buffer.unmap();
  return { index_buffer, meshes, ranges, vertex_buffer };
}

function synchronize_imported_textures(
  device: GPUDevice,
  current: Map<Simple3dTextureId, ImportedTexture>,
  textures: readonly Simple3dTexture[],
): void {
  const retained = new Set<Simple3dTextureId>();
  for (const texture of textures) {
    retained.add(texture.id);
    const existing = current.get(texture.id);
    if (
      existing?.source === texture.source &&
      existing.color_space === texture.color_space
    ) continue;
    existing?.texture.destroy();
    const gpu_texture = device.createTexture({
      size: [texture.source.width, texture.source.height],
      format: texture.color_space === "srgb" ? "rgba8unorm-srgb" : "rgba8unorm",
      usage: gpu_texture_usage.copy_dst | gpu_texture_usage.render_attachment |
        gpu_texture_usage.texture_binding,
    });
    device.queue.copyExternalImageToTexture(
      { source: texture.source },
      { texture: gpu_texture },
      [texture.source.width, texture.source.height],
    );
    current.set(texture.id, {
      color_space: texture.color_space,
      source: texture.source,
      texture: gpu_texture,
    });
  }
  for (const [id, texture] of current) {
    if (retained.has(id)) continue;
    texture.texture.destroy();
    current.delete(id);
  }
}

function append_zero_texture_coordinates(
  position_normal_vertices: readonly number[],
): readonly number[] {
  const vertices: number[] = [];
  for (let offset = 0; offset < position_normal_vertices.length; offset += 6) {
    vertices.push(...position_normal_vertices.slice(offset, offset + 6), 0, 0);
  }
  return vertices;
}

function object_shape_key(object: Simple3dObject): ShapeKey {
  return object.shape === "mesh" ? object.mesh : object.shape;
}

function is_built_in_shape(shape: ShapeKey): shape is Simple3dBuiltInShape {
  return shape === "cube" || shape === "plane" || shape === "sphere";
}

function plane_vertices(): readonly number[] {
  return [
    -0.5,
    0,
    -0.5,
    0,
    1,
    0,
    0.5,
    0,
    0.5,
    0,
    1,
    0,
    0.5,
    0,
    -0.5,
    0,
    1,
    0,
    -0.5,
    0,
    -0.5,
    0,
    1,
    0,
    -0.5,
    0,
    0.5,
    0,
    1,
    0,
    0.5,
    0,
    0.5,
    0,
    1,
    0,
  ];
}

function cube_vertices(): readonly number[] {
  const faces = [
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
    [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
    [[1, 0, 0], [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]],
    [[-1, 0, 0], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
    [[0, 1, 0], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]],
    [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
  ] as const;
  const vertices: number[] = [];
  for (const [normal, corners] of faces) {
    for (const index of [0, 1, 2, 0, 2, 3]) {
      const corner = corners[index]!;
      vertices.push(
        corner[0] * 0.5,
        corner[1] * 0.5,
        corner[2] * 0.5,
        ...normal,
      );
    }
  }
  return vertices;
}

function sphere_vertices(columns: number, rows: number): readonly number[] {
  const vertices: number[] = [];
  const point = (column: number, row: number): Simple3dVector => {
    const longitude = column / columns * Math.PI * 2;
    const latitude = row / rows * Math.PI;
    return [
      Math.sin(latitude) * Math.cos(longitude) * 0.5,
      Math.cos(latitude) * 0.5,
      Math.sin(latitude) * Math.sin(longitude) * 0.5,
    ];
  };
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const a = point(column, row);
      const b = point(column + 1, row);
      const c = point(column + 1, row + 1);
      const d = point(column, row + 1);
      for (const vertex of [a, b, c, a, c, d]) {
        const normal: Simple3dVector = [
          vertex[0] * 2,
          vertex[1] * 2,
          vertex[2] * 2,
        ];
        vertices.push(...vertex, ...normal);
      }
    }
  }
  return vertices;
}
