import type { ModelMesh } from "../runtime/model.ts";
import type {
  BeaconCommand,
  Projection,
  RenderSnapshot,
} from "../runtime/protocol.ts";

const gpu_buffer_usage = {
  copy_dst: 0x08,
  uniform: 0x40,
  vertex: 0x20,
} as const;
const gpu_texture_usage = { render_attachment: 0x10 } as const;

export interface PreviewRenderer {
  readonly mode: "webgpu" | "semantic_only";
  readonly unavailable_reason: string | null;
  render(snapshot: RenderSnapshot): void;
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

export async function create_preview_renderer(
  canvas: HTMLCanvasElement,
  model: ModelMesh,
): Promise<PreviewRenderer> {
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
    context.configure({ device, format, alphaMode: "opaque" });

    const shader = device.createShaderModule({ code: preview_shader_source });
    const compilation = await shader.getCompilationInfo();
    const shader_errors = compilation.messages.filter(
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
    const pipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: {
        module: shader,
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
        module: shader,
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
    const pipeline_error = await device.popErrorScope();
    if (pipeline_error) {
      context.unconfigure();
      device.destroy();
      return create_semantic_renderer(
        `preview pipeline validation failed: ${pipeline_error.message}`,
      );
    }
    const vertex_buffer = device.createBuffer({
      size: model.vertices.byteLength,
      usage: gpu_buffer_usage.vertex | gpu_buffer_usage.copy_dst,
    });
    device.queue.writeBuffer(vertex_buffer, 0, model.vertices);

    let depth_texture: GPUTexture | undefined;
    let depth_width = 0;
    let depth_height = 0;
    const uniform_buffers: GPUBuffer[] = [];
    const bind_groups: GPUBindGroup[] = [];
    const unavailable_reports = new Set<(reason: string) => void>();
    let unavailable_reason: string | null = null;
    let disposed = false;

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

    return {
      get mode() {
        return unavailable_reason ? "semantic_only" : "webgpu";
      },
      get unavailable_reason() {
        return unavailable_reason;
      },
      render(snapshot) {
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

          const commands = device.createCommandEncoder();
          const pass = commands.beginRenderPass({
            colorAttachments: [{
              view: context.getCurrentTexture().createView(),
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
          pass.setPipeline(pipeline);
          pass.setVertexBuffer(0, vertex_buffer);

          for (const [index, beacon] of snapshot.beacons.entries()) {
            const uniform_values = beacon_uniform(
              beacon,
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
                layout: pipeline.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: { buffer: uniform_buffer } }],
              }));
            }
            device.queue.writeBuffer(uniform_buffer, 0, uniform_values);
            pass.setBindGroup(0, bind_groups[index]);
            pass.draw(model.vertex_count);
          }

          pass.end();
          device.queue.submit([commands.finish()]);
        } catch (error) {
          mark_unavailable(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
      on_unavailable(report) {
        unavailable_reports.add(report);
        return () => unavailable_reports.delete(report);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        depth_texture?.destroy();
        vertex_buffer.destroy();
        for (const uniform_buffer of uniform_buffers) uniform_buffer.destroy();
        unavailable_reports.clear();
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

export function project_model_origin(
  position: readonly [number, number, number],
  projection: Projection,
  width: number,
  height: number,
): readonly [number, number] {
  const model = model_matrix(position, 0);
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

function beacon_uniform(
  beacon: BeaconCommand,
  projection: Projection,
  width: number,
  height: number,
): Float32Array {
  const model = model_matrix(beacon.position, beacon.id);
  const model_view_projection = multiply_matrices(
    view_projection_matrix(projection, width, height),
    model,
  );
  const colour = beacon_colour(beacon);
  return new Float32Array([...model_view_projection, ...model, ...colour]);
}

function beacon_colour(
  beacon: BeaconCommand,
): readonly [number, number, number, number] {
  if (!beacon.lit) {
    return beacon.selected ? [0.65, 0.7, 0.82, 0.04] : [0.36, 0.4, 0.5, 0];
  }
  if (beacon.id === 0) return [1, 0.42, 0.05, 0.28];
  if (beacon.id === 1) return [0.05, 0.72, 1, 0.28];
  return [0.58, 0.18, 1, 0.28];
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

function model_matrix(
  fixed_position: readonly [number, number, number],
  id: number,
): Float32Array {
  const position = [
    fixed_position[0] / 1_000_000,
    fixed_position[1] / 1_000_000,
    fixed_position[2] / 1_000_000,
  ] as const;
  const rotation = multiply_matrices(
    rotation_y_matrix(0.35 + id * 0.55),
    rotation_x_matrix(-0.2),
  );
  const transformed = multiply_matrices(rotation, scale_matrix(1.1));
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

function scale_matrix(scale: number): Float32Array {
  return new Float32Array([
    scale,
    0,
    0,
    0,
    0,
    scale,
    0,
    0,
    0,
    0,
    scale,
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
