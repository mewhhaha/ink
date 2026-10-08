import { mat4 } from "@ink/geometry";
import type { Core } from "../core.ts";
import {
  BufferUsage,
  COLOR_FORMAT,
  DEPTH_FORMAT,
  GrowBuffer,
  SAMPLES,
  ShaderStage,
  srgbToLinear,
} from "../gpu.ts";
import { particleCompute, particleRender } from "../shaders/particles.ts";
import type { Camera, ParticleDraw } from "../types.ts";

const LIMIT = 64, SLOTS = 2048, FLOATS = 48;
const cache = new WeakMap<GPUDevice, ReturnType<typeof pipelines>>();
function pipelines(core: Core) {
  const d = core.device;
  const compute = d.createComputePipeline({
    label: "particle simulation and depth sort",
    layout: "auto",
    compute: {
      module: d.createShaderModule({ code: particleCompute }),
      entryPoint: "simulate",
    },
  });
  const layout = d.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: ShaderStage.VERTEX,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: ShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 2,
        visibility: ShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
    ],
  });
  const renderLayout = d.createPipelineLayout({
    bindGroupLayouts: [layout, core.pipelines.materialLayout],
  });
  const module = d.createShaderModule({ code: particleRender });
  const render = (additive: boolean) =>
    d.createRenderPipeline({
      label: additive ? "additive particles" : "alpha particles",
      layout: renderLayout,
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [{
          format: COLOR_FORMAT,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: additive ? "one" : "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: additive ? "zero" : "one",
              dstFactor: additive ? "one" : "one-minus-src-alpha",
              operation: "add",
            },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
      multisample: { count: SAMPLES },
    });
  return { compute, layout, blend: render(false), additive: render(true) };
}

export interface ParticleBatch {
  depth: number;
  index: number;
  count: number;
  additive: boolean;
  material: GPUBindGroup;
}

/** Analytic ballistic motion and stable sorting run together on the GPU. */
export class ParticleSystem {
  private camera: GPUBuffer;
  private emitters: GrowBuffer;
  private particles: GrowBuffer;
  private order: GrowBuffer;
  private pipelines: ReturnType<typeof pipelines>;
  private drawGroup?: GPUBindGroup;
  batches: ParticleBatch[] = [];
  count = 0;

  constructor(private core: Core) {
    const d = core.device;
    this.pipelines = cache.get(d) ?? pipelines(core);
    cache.set(d, this.pipelines);
    this.camera = d.createBuffer({
      label: "particle camera",
      size: 160,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this.emitters = new GrowBuffer(d, BufferUsage.STORAGE, "emitters");
    this.particles = new GrowBuffer(d, BufferUsage.STORAGE, "particles");
    this.order = new GrowBuffer(d, BufferUsage.STORAGE, "particle depth order");
  }

  encode(
    encoder: GPUCommandEncoder,
    draws: readonly ParticleDraw[],
    camera: Camera,
  ) {
    const { device: d, assets } = this.core;
    const active = draws.filter((p) => p.count > 0 && p.time >= 0).slice(
      0,
      LIMIT,
    );
    this.batches = [];
    this.count = 0;
    if (!active.length) return 0;
    const view = new Float32Array(40);
    view.set(mat4.multiply(camera.projection, camera.view));
    view.set(camera.view, 16);
    view.set([camera.view[0], camera.view[4], camera.view[8], 0], 32);
    view.set([camera.view[1], camera.view[5], camera.view[9], 0], 36);
    d.queue.writeBuffer(this.camera, 0, view);
    const data = new Float32Array(active.length * FLOATS);
    const ids = new Uint32Array(data.buffer);
    for (let i = 0; i < active.length; i++) {
      const p = active[i], o = i * FLOATS;
      const count = Math.min(SLOTS, Math.floor(p.count));
      const first = p.rate > 0 ? Math.floor(p.time * p.rate) - count + 1 : 0;
      data.set(p.matrix, o);
      data.set([...p.velocity, p.radius], o + 16);
      data.set(p.spread, o + 20);
      data.set([...p.gravity, p.lifetime], o + 24);
      data.set([...p.color.slice(0, 3).map(srgbToLinear), p.color[3]], o + 28);
      data.set(
        [...p.endColor.slice(0, 3).map(srgbToLinear), p.endColor[3]],
        o + 32,
      );
      data.set([...p.size, p.intensity, p.shape === "spark" ? 1 : 0], o + 36);
      data.set([p.rate, p.time, first, 0], o + 40);
      ids.set([p.seed, count, 0, 0], o + 44);
      // Same center-depth ordering as translucent mesh batches. The compute
      // pass independently sorts every particle inside each emitter/burst.
      const age = p.rate > 0 ? Math.min(p.time, p.lifetime) * 0.5 : p.time;
      const center = mat4.transformPoint(
        p.matrix,
        p.velocity.map((v, axis) =>
          v * age + p.gravity[axis] * age * age * 0.5
        ) as [number, number, number],
      );
      const depth = -mat4.transformPoint(camera.view, center)[2];
      this.batches.push({
        index: i,
        count,
        depth,
        additive: p.blend === "additive",
        material: assets.material(
          assets.getTexture(p.texture),
          assets.flatNormal,
          assets.whiteLinear,
        ),
      });
      this.count += count;
    }
    this.emitters.reserve(data.byteLength);
    this.particles.reserve(active.length * SLOTS * 48);
    this.order.reserve(active.length * SLOTS * 4);
    d.queue.writeBuffer(this.emitters.buffer, 0, data);
    const group = d.createBindGroup({
      layout: this.pipelines.compute.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.camera } },
        { binding: 1, resource: { buffer: this.emitters.buffer } },
        { binding: 2, resource: { buffer: this.particles.buffer } },
        { binding: 3, resource: { buffer: this.order.buffer } },
      ],
    });
    this.drawGroup = d.createBindGroup({
      layout: this.pipelines.layout,
      entries: [
        { binding: 0, resource: { buffer: this.camera } },
        { binding: 1, resource: { buffer: this.particles.buffer } },
        { binding: 2, resource: { buffer: this.order.buffer } },
      ],
    });
    const pass = encoder.beginComputePass({ label: "particles" });
    pass.setPipeline(this.pipelines.compute);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(active.length);
    pass.end();
    return 1;
  }
  draw(pass: GPURenderPassEncoder, batch: ParticleBatch) {
    pass.setPipeline(
      batch.additive ? this.pipelines.additive : this.pipelines.blend,
    );
    pass.setBindGroup(0, this.drawGroup!);
    pass.setBindGroup(1, batch.material);
    pass.draw(6, batch.count, 0, batch.index * SLOTS);
  }
  dispose() {
    this.camera.destroy();
    this.emitters.destroy();
    this.particles.destroy();
    this.order.destroy();
  }
}
