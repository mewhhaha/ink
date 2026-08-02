import type { ModelMesh } from "@ink/engine/model.ts";
import type {
  Projection,
  RenderSnapshot,
  SceneObjectCommand,
  SemanticRegion,
} from "@ink/engine/protocol.ts";

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

export interface PreviewRenderer {
  readonly mode: "webgpu" | "semantic_only";
  readonly unavailable_reason: string | null;
  render(
    snapshot: RenderSnapshot,
    regions: readonly SemanticRegion[],
  ): void;
  on_unavailable(report: (reason: string) => void): () => void;
  dispose(): void;
}

export const preview_shader_source = `
struct ModelUniform {
  model_view_projection: mat4x4f,
  model: mat4x4f,
  colour: vec4f,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
}

@group(0) @binding(0) var<uniform> model_uniform: ModelUniform;

@vertex fn vertex_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = model_uniform.model_view_projection * vec4f(position, 1.0);
  output.normal = normalize((model_uniform.model * vec4f(normal, 0.0)).xyz);
  return output;
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let light_direction = normalize(vec3f(0.35, 0.8, 0.55));
  let diffuse = max(dot(input.normal, light_direction), 0.0);
  let light = 0.3 + diffuse * 0.7 + model_uniform.colour.a;
  return vec4f(model_uniform.colour.rgb * light, 1.0);
}
`;

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
): Promise<PreviewRenderer> {
  const mesh_ids = new Set<number>();
  for (const mesh of meshes) {
    if (mesh_ids.has(mesh.id)) {
      throw new Error(`preview contains duplicate mesh id ${mesh.id}`);
    }
    mesh_ids.add(mesh.id);
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
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return create_semantic_renderer("no compatible WebGPU adapter was found");
    }
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
      alphaMode: "opaque",
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
        buffers: [{
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
          ],
        }],
      },
      fragment: {
        module: model_shader,
        entryPoint: "fragment_main",
        targets: [{ format }],
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
    for (const mesh of meshes) {
      const vertex_buffer = device.createBuffer({
        size: mesh.model.vertices.byteLength,
        usage: gpu_buffer_usage.vertex | gpu_buffer_usage.copy_dst,
      });
      device.queue.writeBuffer(vertex_buffer, 0, mesh.model.vertices);
      mesh_buffers.set(mesh.id, {
        vertex_buffer,
        vertex_count: mesh.model.vertex_count,
      });
    }

    let depth_texture: GPUTexture | undefined;
    let depth_width = 0;
    let depth_height = 0;
    const uniform_buffers: GPUBuffer[] = [];
    const bind_groups: GPUBindGroup[] = [];
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
            clearValue: { r: 0.012, g: 0.018, b: 0.035, a: 1 },
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

        const resolved_objects = resolve_scene_objects(snapshot.objects);
        let visible_object_index = 0;
        for (const object of snapshot.objects) {
          const resolved = resolved_objects.get(object.id);
          if (!resolved?.visible) continue;
          const index = visible_object_index;
          visible_object_index += 1;
          const mesh = mesh_buffers.get(object.mesh);
          if (!mesh) {
            throw new Error(
              `scene object ${object.id} selects missing mesh ${object.mesh}`,
            );
          }
          const uniform_values = scene_object_uniform(
            object,
            resolved.model,
            snapshot.projection,
            canvas.clientWidth,
            canvas.clientHeight,
          );
          let uniform_buffer = uniform_buffers[index];
          if (!uniform_buffer) {
            uniform_buffer = device.createBuffer({
              size: uniform_values.byteLength,
              usage: gpu_buffer_usage.uniform | gpu_buffer_usage.copy_dst,
            });
            uniform_buffers.push(uniform_buffer);
            bind_groups.push(device.createBindGroup({
              layout: model_pipeline.getBindGroupLayout(0),
              entries: [{ binding: 0, resource: { buffer: uniform_buffer } }],
            }));
          }
          device.queue.writeBuffer(uniform_buffer, 0, uniform_values);
          pass.setVertexBuffer(0, mesh.vertex_buffer);
          pass.setBindGroup(0, bind_groups[index]);
          pass.draw(mesh.vertex_count);
        }

        pass.setPipeline(semantic_pipeline);
        for (const region of regions) {
          const resolved = resolved_objects.get(region.placement.object);
          if (!resolved) {
            throw new Error(
              `semantic region ${
                JSON.stringify(region.id)
              } attaches to missing scene object ${region.placement.object}`,
            );
          }
          const element = semantic_elements.get(region.id);
          if (element) {
            element.style.visibility = resolved.visible ? "" : "hidden";
          }
          if (!resolved.visible) continue;
          const semantic_texture = semantic_textures.get(region.id);
          if (!semantic_texture) continue;
          const model_view_projection =
            semantic_model_view_projection_from_model(
              region.placement,
              resolved.model,
              snapshot.projection,
              canvas.clientWidth,
              canvas.clientHeight,
            );
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
            element.style.transform = html_canvas.getElementTransform(
              element,
              draw_transform,
            ).toString();
            if (getComputedStyle(element).opacity === "0") continue;
          }

          pass.setBindGroup(0, semantic_texture.bind_group);
          pass.draw(6);
        }

        pass.end();
        device.queue.submit([commands.finish()]);
      } catch (error) {
        mark_unavailable(
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    const paint_semantic_elements = () => {
      if (disposed || unavailable_reason) return;
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
        } catch (error) {
          mark_unavailable(
            error instanceof Error ? error.message : String(error),
          );
          return;
        }
      }
      if (last_snapshot) render_frame(last_snapshot, last_regions);
    };
    canvas.addEventListener("paint", paint_semantic_elements);

    return {
      get mode() {
        return unavailable_reason ? "semantic_only" : "webgpu";
      },
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
      dispose() {
        if (disposed) return;
        disposed = true;
        if (semantic_paint_frame !== undefined) {
          cancelAnimationFrame(semantic_paint_frame);
        }
        depth_texture?.destroy();
        for (const mesh of mesh_buffers.values()) mesh.vertex_buffer.destroy();
        for (const uniform_buffer of uniform_buffers) uniform_buffer.destroy();
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
  placement: SemanticRegion["placement"],
  object: SceneObjectCommand,
  projection: Projection,
  width: number,
  height: number,
): Float32Array {
  return semantic_model_view_projection_from_model(
    placement,
    scene_object_model_matrix(object),
    projection,
    width,
    height,
  );
}

function semantic_model_view_projection_from_model(
  placement: SemanticRegion["placement"],
  object_model: Float32Array,
  projection: Projection,
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
    view_projection_matrix(projection, width, height),
    model,
  );
}

export function project_model_origin(
  position: readonly [number, number, number],
  projection: Projection,
  width: number,
  height: number,
): readonly [number, number] {
  const model = translation_matrix(
    position[0] / 1_000_000,
    position[1] / 1_000_000,
    position[2] / 1_000_000,
  );
  const view_projection = view_projection_matrix(projection, width, height);
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
    unavailable_reason: reason,
    render() {},
    on_unavailable() {
      return () => {};
    },
    dispose() {},
  };
}

function scene_object_uniform(
  object: SceneObjectCommand,
  model: Float32Array,
  projection: Projection,
  width: number,
  height: number,
): Float32Array {
  const model_view_projection = multiply_matrices(
    view_projection_matrix(projection, width, height),
    model,
  );
  const colour = [...object.color, object.emissive] as const;
  return new Float32Array([...model_view_projection, ...model, ...colour]);
}

function view_projection_matrix(
  projection: Projection,
  width: number,
  height: number,
): Float32Array {
  const near = 0.1;
  const far = 100;
  const safe_width = Math.max(1, width);
  const safe_height = Math.max(1, height);
  const projection_matrix = projection === "perspective"
    ? new Float32Array([
      840 / safe_width,
      0,
      0,
      0,
      0,
      840 / safe_height,
      0,
      0,
      0,
      0,
      far / (near - far),
      -1,
      0,
      0,
      near * far / (near - far),
      0,
    ])
    : new Float32Array([
      140 / safe_width,
      0,
      0,
      0,
      0,
      140 / safe_height,
      0,
      0,
      0,
      0,
      1 / (near - far),
      0,
      0,
      0,
      near / (near - far),
      1,
    ]);
  return multiply_matrices(projection_matrix, translation_matrix(0, 0, -6));
}

export interface ResolvedSceneObject {
  readonly model: Float32Array;
  readonly visible: boolean;
}

export function resolve_scene_objects(
  objects: readonly SceneObjectCommand[],
): ReadonlyMap<number, ResolvedSceneObject> {
  const by_id = new Map<number, SceneObjectCommand>();
  for (const object of objects) {
    if (by_id.has(object.id)) {
      throw new Error(`scene contains duplicate object id ${object.id}`);
    }
    by_id.set(object.id, object);
  }
  const resolved = new Map<number, ResolvedSceneObject>();
  const resolving: number[] = [];

  const resolve_object = (object: SceneObjectCommand): ResolvedSceneObject => {
    const existing = resolved.get(object.id);
    if (existing) return existing;
    const cycle_start = resolving.indexOf(object.id);
    if (cycle_start >= 0) {
      const cycle = [...resolving.slice(cycle_start), object.id].join(" -> ");
      throw new Error(`scene object parent cycle: ${cycle}`);
    }
    resolving.push(object.id);
    const local_model = scene_object_model_matrix(object);
    let model = local_model;
    let visible = object.visible;
    if (object.parent !== null) {
      const parent = by_id.get(object.parent);
      if (!parent) {
        throw new Error(
          `scene object ${object.id} has missing parent ${object.parent}`,
        );
      }
      const resolved_parent = resolve_object(parent);
      model = multiply_matrices(resolved_parent.model, local_model);
      visible = visible && resolved_parent.visible;
    }
    resolving.pop();
    const current = { model, visible };
    resolved.set(object.id, current);
    return current;
  };

  for (const object of objects) resolve_object(object);
  return resolved;
}

function scene_object_model_matrix(object: SceneObjectCommand): Float32Array {
  const position = [
    object.position[0] / 1_000_000,
    object.position[1] / 1_000_000,
    object.position[2] / 1_000_000,
  ] as const;
  const rotation = multiply_matrices(
    rotation_z_matrix(object.rotation_radians[2]),
    multiply_matrices(
      rotation_y_matrix(object.rotation_radians[1]),
      rotation_x_matrix(object.rotation_radians[0]),
    ),
  );
  const transformed = multiply_matrices(
    rotation,
    scale_xyz_matrix(
      object.scale[0] / 1_000_000,
      object.scale[1] / 1_000_000,
      object.scale[2] / 1_000_000,
    ),
  );
  return multiply_matrices(
    translation_matrix(position[0], position[1], position[2]),
    transformed,
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

function rotation_x_matrix(angle: number): Float32Array {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return new Float32Array([
    1,
    0,
    0,
    0,
    0,
    cosine,
    sine,
    0,
    0,
    -sine,
    cosine,
    0,
    0,
    0,
    0,
    1,
  ]);
}

function rotation_y_matrix(angle: number): Float32Array {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return new Float32Array([
    cosine,
    0,
    -sine,
    0,
    0,
    1,
    0,
    0,
    sine,
    0,
    cosine,
    0,
    0,
    0,
    0,
    1,
  ]);
}

function rotation_z_matrix(angle: number): Float32Array {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return new Float32Array([
    cosine,
    sine,
    0,
    0,
    -sine,
    cosine,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
  ]);
}
