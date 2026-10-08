/**
 * Pieces every shadow-map pass shares: the depth-only pipeline with its
 * per-pass dynamic-offset uniform, and a content signature of the shadow
 * casters so systems can skip re-rendering a map nothing changed in.
 */
import type { Core } from "../core.ts";
import {
  BufferUsage,
  DEPTH_FORMAT,
  INSTANCE_FLOATS,
  ShaderStage,
  VERTEX_STRIDE,
} from "../gpu.ts";
import type { Plan } from "../plan.ts";
import { shadowPassShader } from "../shaders/shadow_pass.ts";

/** Dynamic uniform offsets must be a multiple of this (the WebGPU default). */
const SLOT_BYTES = 256;

interface Kit {
  pipeline: GPURenderPipeline;
  layout: GPUBindGroupLayout;
}
const kits = new WeakMap<GPUDevice, Kit>();

function kitOf(core: Core): Kit {
  let kit = kits.get(core.device);
  if (!kit) {
    const { device, pipelines } = core;
    const layout = device.createBindGroupLayout({
      label: "shadow-pass",
      entries: [{
        binding: 0,
        visibility: ShaderStage.VERTEX,
        buffer: { type: "uniform", hasDynamicOffset: true },
      }],
    });
    const module = device.createShaderModule({
      label: "shadow-pass",
      code: shadowPassShader,
    });
    const pipeline = device.createRenderPipeline({
      label: "shadow-pass",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [
          layout,
          pipelines.materialLayout,
          pipelines.instanceLayout,
        ],
      }),
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [{
          arrayStride: VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x2" },
            { shaderLocation: 3, offset: 32, format: "float32x4" },
          ],
        }],
      },
      fragment: { module, entryPoint: "fs", targets: [] },
      primitive: { cullMode: "none" },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less",
        depthBias: 1,
        depthBiasSlopeScale: 1.5,
      },
    });
    kits.set(device, kit = { pipeline, layout });
  }
  return kit;
}

/** View-projection matrices of a system's shadow passes, one dynamic-offset
 * slot each. */
export class ShadowPasses {
  private buffer: GPUBuffer;
  readonly group: GPUBindGroup;
  private pipeline: GPURenderPipeline;

  constructor(private core: Core, readonly slots: number) {
    const kit = kitOf(core);
    this.pipeline = kit.pipeline;
    this.buffer = core.device.createBuffer({
      label: "shadow-pass",
      size: slots * SLOT_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this.group = core.device.createBindGroup({
      layout: kit.layout,
      entries: [{ binding: 0, resource: { buffer: this.buffer, size: 64 } }],
    });
  }

  /** Upload the matrix of pass `slot`. */
  set(slot: number, viewProj: Float32Array) {
    this.core.device.queue.writeBuffer(
      this.buffer,
      slot * SLOT_BYTES,
      viewProj as Float32Array<ArrayBuffer>,
    );
  }

  /** Start a depth-only pass into `view` using the matrix of `slot`; the
   * caller draws the plan and ends it. */
  begin(
    encoder: GPUCommandEncoder,
    view: GPUTextureView,
    slot: number,
  ): GPURenderPassEncoder {
    const pass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view,
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group, [slot * SLOT_BYTES]);
    return pass;
  }

  dispose() {
    this.buffer.destroy();
  }
}

const ids = new WeakMap<object, number>();
let nextId = 1;
/** A stable small number for an object (buffers, meshes). */
export function idOf(o: object): number {
  let id = ids.get(o);
  if (!id) ids.set(o, id = nextId++);
  return id;
}

const FNV = 0x01000193;
/** FNV-1a style mix of 32-bit words. */
export function mix(h: number, word: number): number {
  return Math.imul(h ^ word, FNV) >>> 0;
}
export function hashFloats(h: number, values: ArrayLike<number>): number {
  const u = new Uint32Array(new Float32Array(values).buffer);
  for (let i = 0; i < u.length; i++) h = mix(h, u[i]);
  return h;
}

const signatures = new WeakMap<Plan, number>();
/** Changes whenever a shadow caster is added, removed, moved or replaced. */
export function casterSignature(plan: Plan): number {
  let sig = signatures.get(plan);
  if (sig === undefined) {
    let h = 0x811c9dc5;
    const words = new Uint32Array(plan.data.buffer, plan.data.byteOffset);
    for (const b of plan.batches) {
      if (!b.castsShadows) continue;
      h = mix(mix(h, idOf(b.mesh.vertex)), b.count);
      h = mix(h, idOf(b.material));
      for (let i = 0; i < b.count; i++) {
        const o = (b.first + i) * INSTANCE_FLOATS;
        for (let k = 0; k < 16; k++) h = mix(h, words[o + k]);
        for (const k of [31, 37, 38, 42, 43]) h = mix(h, words[o + k]);
      }
    }
    signatures.set(plan, sig = h);
  }
  return sig;
}

/** Signature of everything in the plan (AO sees all geometry). */
const geometrySignatures = new WeakMap<Plan, number>();
export function geometrySignature(plan: Plan): number {
  let sig = geometrySignatures.get(plan);
  if (sig === undefined) {
    let h = 0x811c9dc5;
    const words = new Uint32Array(plan.data.buffer, plan.data.byteOffset);
    for (const b of plan.batches) {
      if (b.alphaMode === "blend" || b.alphaMode === "additive") continue;
      h = mix(mix(h, idOf(b.mesh.vertex)), b.count);
      h = mix(h, idOf(b.material));
      for (let i = 0; i < b.count; i++) {
        const o = (b.first + i) * INSTANCE_FLOATS;
        for (let k = 0; k < 16; k++) h = mix(h, words[o + k]);
        for (const k of [31, 37, 38, 42, 43]) h = mix(h, words[o + k]);
      }
    }
    geometrySignatures.set(plan, sig = h);
  }
  return sig;
}
