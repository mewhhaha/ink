import { mat4 } from "@ink/geometry";
import type { Core } from "./core.ts";
import {
  BufferUsage,
  COLOR_FORMAT,
  DEPTH_FORMAT,
  GrowBuffer,
  ShaderStage,
  texture2d,
  TextureUsage,
} from "./gpu.ts";
import { vertexLayout } from "./pipelines.ts";
import type { Plan } from "./plan.ts";
import { motionShader, temporalShader } from "./shaders/temporal.ts";
import { drawPlan } from "./systems.ts";
import {
  jitterCamera,
  TemporalHistory,
  viewProjection,
} from "./temporal_history.ts";
import type { Camera } from "./types.ts";

interface Kit {
  motionLayout: GPUBindGroupLayout;
  motion: GPURenderPipeline;
  motionDouble: GPURenderPipeline;
  resolveLayout: GPUBindGroupLayout;
  resolve: GPURenderPipeline;
  sampler: GPUSampler;
}
const kits = new WeakMap<GPUDevice, Kit>();
function kitOf(core: Core): Kit {
  const { device, pipelines } = core;
  let kit = kits.get(device);
  if (kit) return kit;
  const V = ShaderStage.VERTEX, F = ShaderStage.FRAGMENT;
  const motionLayout = device.createBindGroupLayout({
    label: "motion",
    entries: [
      { binding: 0, visibility: V, buffer: { type: "uniform" } },
      { binding: 1, visibility: V | F, buffer: { type: "read-only-storage" } },
    ],
  });
  const motionModule = device.createShaderModule({
    label: "motion",
    code: motionShader,
  });
  const motionPipeline = (cullMode: GPUCullMode) =>
    device.createRenderPipeline({
      label: `motion-${cullMode}`,
      layout: device.createPipelineLayout({
        bindGroupLayouts: [
          pipelines.frameLayout,
          pipelines.materialLayout,
          pipelines.instanceLayout,
          motionLayout,
        ],
      }),
      vertex: {
        module: motionModule,
        entryPoint: "vs",
        buffers: [vertexLayout],
      },
      fragment: {
        module: motionModule,
        entryPoint: "fs",
        targets: [{ format: COLOR_FORMAT }],
      },
      primitive: { cullMode },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
  const resolveLayout = device.createBindGroupLayout({
    label: "temporal",
    entries: [
      ...[0, 1, 2, 4].map((binding) => ({
        binding,
        visibility: F,
        texture: { sampleType: "float" as const },
      })),
      {
        binding: 3,
        visibility: F,
        texture: { sampleType: "unfilterable-float" },
      },
      { binding: 5, visibility: F, sampler: { type: "filtering" } },
      { binding: 6, visibility: F, buffer: { type: "uniform" } },
    ],
  });
  const resolveModule = device.createShaderModule({
    label: "temporal",
    code: temporalShader,
  });
  kit = {
    motionLayout,
    motion: motionPipeline("back"),
    motionDouble: motionPipeline("none"),
    resolveLayout,
    resolve: device.createRenderPipeline({
      label: "temporal-resolve",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [resolveLayout],
      }),
      vertex: { module: resolveModule, entryPoint: "vs" },
      fragment: {
        module: resolveModule,
        entryPoint: "fs",
        targets: [{ format: COLOR_FORMAT }, { format: "r32float" }],
      },
    }),
    sampler: device.createSampler({ magFilter: "linear", minFilter: "linear" }),
  };
  kits.set(device, kit);
  return kit;
}

/** Motion vectors, native-resolution color/depth histories and their resolve. */
export class Temporal {
  readonly history = new TemporalHistory();
  readonly jitter: [number, number] = [0, 0];
  private kit: Kit;
  private previous: GrowBuffer;
  private cameras: GPUBuffer;
  private uniform: GPUBuffer;
  private motionGroup?: GPUBindGroup;
  private size = "";
  private velocity?: GPUTexture;
  private depth?: GPUTexture;
  private colors: GPUTexture[] = [];
  private depths: GPUTexture[] = [];
  private outputIndex = 0;

  constructor(private core: Core) {
    this.kit = kitOf(core);
    this.previous = new GrowBuffer(
      core.device,
      BufferUsage.STORAGE,
      "previous instances",
      256,
    );
    const uniform = (label: string) =>
      core.device.createBuffer({
        label,
        size: 192,
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      });
    this.cameras = uniform("motion cameras");
    this.uniform = uniform("temporal resolve");
  }

  prepare(
    plan: Plan,
    camera: Camera,
    dimensions: {
      width: number;
      height: number;
      outputWidth: number;
      outputHeight: number;
    },
    version: number,
    tick?: number,
    reset = false,
  ): Camera {
    const { width, height, outputWidth, outputHeight } = dimensions;
    const size = `${width}:${height}:${outputWidth}:${outputHeight}`;
    if (size !== this.size) {
      this.releaseTargets();
      const usage = TextureUsage.TEXTURE_BINDING |
        TextureUsage.RENDER_ATTACHMENT;
      const texture = (
        label: string,
        w: number,
        h: number,
        format: GPUTextureFormat,
      ) => texture2d(this.core.device, label, w, h, format, usage);
      this.velocity = texture("velocity", width, height, COLOR_FORMAT);
      this.depth = texture("motion depth", width, height, DEPTH_FORMAT);
      for (let i = 0; i < 2; i++) {
        this.colors.push(
          texture("temporal color", outputWidth, outputHeight, COLOR_FORMAT),
        );
        this.depths.push(
          texture("temporal depth", outputWidth, outputHeight, "r32float"),
        );
      }
      this.size = size;
    }
    const prepared = this.history.prepare(
      plan,
      camera,
      `${size}:${version}`,
      tick,
      reset,
    );
    this.jitter[0] = prepared.jitter[0];
    this.jitter[1] = prepared.jitter[1];
    const { device } = this.core;
    if (this.previous.reserve(prepared.previous.byteLength)) {
      this.motionGroup = undefined;
    }
    device.queue.writeBuffer(this.previous.buffer, 0, prepared.previous);
    const current = viewProjection(camera),
      old = viewProjection(prepared.previousCamera);
    device.queue.writeBuffer(
      this.cameras,
      0,
      new Float32Array([...current, ...old, ...prepared.previousCamera.view]),
    );
    device.queue.writeBuffer(
      this.uniform,
      0,
      new Float32Array([
        ...mat4.invert(current),
        ...old,
        ...camera.position,
        0,
        outputWidth,
        outputHeight,
        width,
        height,
        ...this.jitter,
        prepared.valid ? 1 : 0,
        camera.orthographic ? 0 : 1,
      ]),
    );
    this.motionGroup ??= device.createBindGroup({
      layout: this.kit.motionLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameras } },
        { binding: 1, resource: { buffer: this.previous.buffer } },
      ],
    });
    return jitterCamera(camera, ...this.jitter, width, height);
  }

  encodeMotion(
    encoder: GPUCommandEncoder,
    plan: Plan,
    frameGroup: GPUBindGroup,
    instanceGroup: GPUBindGroup,
  ) {
    const pass = encoder.beginRenderPass({
      label: "motion vectors",
      colorAttachments: [{
        view: this.velocity!.createView(),
        clearValue: [0, 0, 0, 0],
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: this.depth!.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });
    pass.setBindGroup(0, frameGroup);
    pass.setBindGroup(3, this.motionGroup!);
    drawPlan(pass, { plan, instanceGroup }, {
      filter: (b) => b.alphaMode !== "blend" && b.alphaMode !== "additive",
      pipeline: (b) => b.doubleSided ? this.kit.motionDouble : this.kit.motion,
    });
    pass.end();
  }

  resolve(
    encoder: GPUCommandEncoder,
    current: GPUTextureView,
    transparency: GPUTextureView | null,
  ): GPUTextureView {
    const next = 1 - this.outputIndex;
    const output = this.colors[next].createView();
    const pass = encoder.beginRenderPass({
      label: "temporal resolve",
      colorAttachments: [
        { view: output, loadOp: "clear", storeOp: "store" },
        {
          view: this.depths[next].createView(),
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.kit.resolve);
    pass.setBindGroup(
      0,
      this.core.device.createBindGroup({
        layout: this.kit.resolveLayout,
        entries: [
          { binding: 0, resource: current },
          { binding: 1, resource: this.velocity!.createView() },
          { binding: 2, resource: this.colors[this.outputIndex].createView() },
          { binding: 3, resource: this.depths[this.outputIndex].createView() },
          {
            binding: 4,
            resource: transparency ?? this.core.dummies.transparent,
          },
          { binding: 5, resource: this.kit.sampler },
          { binding: 6, resource: { buffer: this.uniform } },
        ],
      }),
    );
    pass.draw(3);
    pass.end();
    this.outputIndex = next;
    return output;
  }

  private releaseTargets() {
    this.velocity?.destroy();
    this.depth?.destroy();
    for (const texture of [...this.colors, ...this.depths]) texture.destroy();
    this.colors = [];
    this.depths = [];
    this.outputIndex = 0;
  }
  dispose() {
    this.releaseTargets();
    this.history.reset();
    this.previous.destroy();
    this.cameras.destroy();
    this.uniform.destroy();
  }
}
