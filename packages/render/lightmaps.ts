/** Incremental GPU path tracing of static diffuse bounce light. */
import type { Core } from "./core.ts";
import {
  BufferUsage,
  INSTANCE_FLOATS,
  ShaderStage,
  srgbToLinear,
  TextureUsage,
} from "./gpu.ts";
import {
  type LightmapGeometry,
  lightmapGeometry,
} from "./lightmap_geometry.ts";
import type { Plan } from "./plan.ts";
import { lightmapBakeShader } from "./shaders/lightmaps.ts";
import type { Environment, RenderScene } from "./types.ts";

export const LIGHTMAP_SAMPLES = 32;
const kits = new WeakMap<
  GPUDevice,
  { pipeline: GPUComputePipeline; layout: GPUBindGroupLayout }
>();
function kitOf(device: GPUDevice) {
  let kit = kits.get(device);
  if (!kit) {
    const layout = device.createBindGroupLayout({
      label: "lightmap bake",
      entries: [
        ...[0, 1, 2, 3, 4, 5].map((binding) => ({
          binding,
          visibility: ShaderStage.COMPUTE,
          buffer: {
            type: (binding === 5
              ? "storage"
              : "read-only-storage") as GPUBufferBindingType,
          },
        })),
        {
          binding: 6,
          visibility: ShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba16float" },
        },
        {
          binding: 7,
          visibility: ShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
      ],
    });
    kit = {
      layout,
      pipeline: device.createComputePipeline({
        label: "lightmap path tracer",
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: {
          module: device.createShaderModule({
            label: "lightmap path tracer",
            code: lightmapBakeShader,
          }),
          entryPoint: "main",
        },
      }),
    };
    kits.set(device, kit);
  }
  return kit;
}

export class Lightmaps {
  samples = 0;
  count = 0;
  private signature = "";
  private buffers: GPUBuffer[] = [];
  private texture?: GPUTexture;
  private view?: GPUTextureView;
  private charts?: GPUBuffer;
  private uniform?: GPUBuffer;
  private group?: GPUBindGroup;
  private geometry?: LightmapGeometry;
  private lightCount = 0;
  constructor(private core: Core) {}

  prepare(
    scene: RenderScene,
    plan: Plan,
    environment: Environment,
    disabled = false,
  ) {
    if (disabled || environment.indirect <= 0) {
      if (this.texture) this.dispose();
      return;
    }
    const { device, assets } = this.core;
    const signature = JSON.stringify([
      assets.version,
      scene.brushes.filter((b) => b.bakeLighting !== false).map((
        b,
      ) => [b.entity, b.geometry.key, Array.from(b.matrix)]),
      scene.draws.filter((d) => d.bakeLighting),
      scene.lights,
    ]);
    if (signature !== this.signature) {
      this.dispose();
      this.signature = signature;
      const geometry = this.geometry = lightmapGeometry(scene, assets);
      this.count = geometry.count;
      if (!this.count) return;
      if (geometry.size > device.limits.maxTextureDimension2D) {
        throw new Error("lightmap atlas exceeds this GPU's texture size");
      }
      const buffer = (
        name: string,
        data: Float32Array | number,
        usage: GPUBufferUsageFlags = BufferUsage.STORAGE,
      ) => {
        const result = device.createBuffer({
          label: name,
          size: typeof data === "number" ? data : Math.max(16, data.byteLength),
          usage: usage | BufferUsage.COPY_DST,
        });
        this.buffers.push(result);
        if (typeof data !== "number") device.queue.writeBuffer(result, 0, data);
        return result;
      };
      const triangles = buffer("bake triangles", geometry.triangles);
      const nodes = buffer("bake BVH", geometry.nodes);
      this.charts = buffer("lightmap charts", geometry.charts);
      const vertices = buffer("lightmap chart boundaries", geometry.vertices);
      const lights = new Float32Array(Math.max(1, scene.lights.length) * 12);
      scene.lights.forEach((l, i) => {
        lights.set([
          ...l.position,
          ["directional", "point", "spot"].indexOf(l.kind),
          ...l.color.map((v) => srgbToLinear(v) * l.intensity),
          l.range || 1e6,
          ...l.direction,
          Math.cos(l.angle * Math.PI / 360),
        ], i * 12);
      });
      this.lightCount = scene.lights.length;
      const lightBuffer = buffer("bake lights", lights);
      const accumulated = buffer("lightmap sums", geometry.size ** 2 * 16);
      this.uniform = buffer("lightmap settings", 32, BufferUsage.UNIFORM);
      this.texture = device.createTexture({
        label: "baked indirect lighting",
        size: [geometry.size, geometry.size],
        format: "rgba16float",
        usage: TextureUsage.TEXTURE_BINDING | TextureUsage.STORAGE_BINDING,
      });
      this.view = this.texture.createView();
      this.group = device.createBindGroup({
        layout: kitOf(device).layout,
        entries: [
          ...[triangles, nodes, lightBuffer, this.charts, vertices, accumulated]
            .map((buffer, binding) => ({ binding, resource: { buffer } })),
          { binding: 6, resource: this.view },
          { binding: 7, resource: { buffer: this.uniform } },
        ],
      });
    }
    if (this.geometry) {
      const words = new Uint32Array(plan.data.buffer);
      for (const batch of plan.batches) {
        if (batch.brush) {
          for (let i = batch.first; i < batch.first + batch.count; i++) {
            const at = i * INSTANCE_FLOATS;
            plan.data[at + 49] = this.geometry.offsets.get(words[at + 40]) ?? 0;
          }
        }
      }
    }
  }

  bindings() {
    return { lightmap: this.view, lightmapCharts: this.charts };
  }

  encode(encoder: GPUCommandEncoder, still: boolean) {
    if (!this.group || this.samples >= LIGHTMAP_SAMPLES) return 0;
    const samples = still
      ? LIGHTMAP_SAMPLES - this.samples
      : Math.min(2, LIGHTMAP_SAMPLES - this.samples);
    const geometry = this.geometry!;
    this.core.device.queue.writeBuffer(
      this.uniform!,
      0,
      new Uint32Array([
        geometry.size,
        geometry.columns,
        geometry.count,
        this.lightCount,
        this.samples,
        samples,
        0,
        0,
      ]),
    );
    const pass = encoder.beginComputePass({ label: "bake indirect light" });
    pass.setPipeline(kitOf(this.core.device).pipeline);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(
      Math.ceil(geometry.size / 8),
      Math.ceil(geometry.size / 8),
    );
    pass.end();
    this.samples += samples;
    return 1;
  }

  dispose() {
    for (const b of this.buffers) b.destroy();
    this.buffers = [];
    this.texture?.destroy();
    this.texture = undefined;
    this.view = undefined;
    this.charts = undefined;
    this.uniform = undefined;
    this.group = undefined;
    this.geometry = undefined;
    this.samples = 0;
    this.count = 0;
    this.signature = "";
  }
}
