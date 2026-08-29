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
export type Simple3dShape = "cube" | "plane" | "sphere";

export interface Simple3dMaterial {
  readonly albedo: Simple3dVector;
  readonly emissive: Simple3dVector;
  readonly metallic: number;
  readonly roughness: number;
}

export interface Simple3dObject {
  readonly id: string;
  readonly shape: Simple3dShape;
  readonly position: Simple3dVector;
  readonly rotation_y_radians: number;
  readonly scale: Simple3dVector;
  readonly material: Simple3dMaterial;
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
  uniform: 0x40,
  vertex: 0x20,
} as const;
const gpu_texture_usage = {
  render_attachment: 0x10,
  texture_binding: 0x04,
} as const;
const instance_float_count = 24;
const maximum_point_lights = 4;
const maximum_spot_lights = 2;
const shadow_map_size = 2048;

interface ShapeGeometry {
  readonly first_vertex: number;
  readonly vertex_count: number;
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
    arrayStride: 24,
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x3" },
      { shaderLocation: 1, offset: 12, format: "float32x3" },
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
    primitive: { topology: "triangle-list", cullMode: "back" },
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
    primitive: { topology: "triangle-list", cullMode: "front" },
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
      const batches = scene_instances(scene.objects);
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
      const light_view_projection = light_matrix(
        scene.directional_light.direction,
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
        instance_buffer,
        batches.ranges,
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
        instance_buffer,
        batches.ranges,
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
  instance_buffer: GPUBuffer,
  ranges: ReadonlyMap<
    Simple3dShape,
    { readonly first: number; readonly count: number }
  >,
): void {
  pass.setVertexBuffer(0, geometry_buffer);
  pass.setVertexBuffer(1, instance_buffer);
  for (const shape of ["cube", "plane", "sphere"] as const) {
    const range = ranges.get(shape);
    if (range === undefined || range.count === 0) continue;
    const shape_geometry = geometry.shapes.get(shape)!;
    pass.draw(
      shape_geometry.vertex_count,
      range.count,
      shape_geometry.first_vertex,
      range.first,
    );
  }
}

function scene_instances(objects: readonly Simple3dObject[]): {
  readonly values: Float32Array;
  readonly ranges: ReadonlyMap<
    Simple3dShape,
    { readonly first: number; readonly count: number }
  >;
} {
  const ordered = ["cube", "plane", "sphere"].flatMap((shape) =>
    objects.filter((object) => object.shape === shape)
  );
  const values = new Float32Array(ordered.length * instance_float_count);
  const ranges = new Map<
    Simple3dShape,
    { readonly first: number; readonly count: number }
  >();
  let first = 0;
  for (const shape of ["cube", "plane", "sphere"] as const) {
    const matching = ordered.filter((object) => object.shape === shape);
    ranges.set(shape, { first, count: matching.length });
    first += matching.length;
  }
  for (const [index, object] of ordered.entries()) {
    const offset = index * instance_float_count;
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

function light_matrix(direction: Simple3dVector): readonly number[] {
  const length = Math.hypot(...direction);
  const normalized: Simple3dVector = length === 0
    ? [0.4, -1, 0.3]
    : [direction[0] / length, direction[1] / length, direction[2] / length];
  const eye = vec3(
    -normalized[0] * 28,
    -normalized[1] * 28,
    -normalized[2] * 28,
  );
  const view = look_at_view(eye, vec3(0, 2, 0), vec3(0, 1, 0));
  const projection = orthographic_projection({
    left: -24,
    right: 24,
    bottom: -24,
    top: 24,
    near_plane: 0.1,
    far_plane: 80,
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
  for (const object of scene.objects) {
    if (ids.has(object.id)) {
      throw new Error(
        `simple 3D scene repeats object id ${JSON.stringify(object.id)}`,
      );
    }
    ids.add(object.id);
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
  readonly shapes: ReadonlyMap<Simple3dShape, ShapeGeometry>;
} {
  const cube = cube_vertices();
  const plane = plane_vertices();
  const sphere = sphere_vertices(20, 12);
  return {
    vertices: new Float32Array([...cube, ...plane, ...sphere]),
    shapes: new Map([
      ["cube", { first_vertex: 0, vertex_count: cube.length / 6 }],
      ["plane", {
        first_vertex: cube.length / 6,
        vertex_count: plane.length / 6,
      }],
      ["sphere", {
        first_vertex: (cube.length + plane.length) / 6,
        vertex_count: sphere.length / 6,
      }],
    ]),
  };
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
