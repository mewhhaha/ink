/**
 * Ambient occlusion system (ground-truth AO, see shaders/ao.ts). At high
 * quality, every frame whose view or geometry changed:
 *
 *   1. prepass   world normal + view depth of the whole plan, half resolution
 *   2. gtao      horizon-based visibility, blue-noise rotated slices
 *   3. blur x2   separable bilateral blur
 *
 * and publishes an rg16float half-resolution image (visibility, view depth)
 * at binding 5. Low quality skips all of it (the hook then returns 1).
 * `environment.ao_radius` is the world-space radius; the light loop applies
 * `environment.ambient_occlusion` as the strength.
 */
import {
  BufferUsage,
  DEPTH_FORMAT,
  ShaderStage,
  TextureUsage,
  VERTEX_STRIDE,
} from "../gpu.ts";
import type { Core } from "../core.ts";
import { aoPrepassShader, aoShader } from "../shaders/ao.ts";
import { drawPlan } from "../systems.ts";
import type {
  FrameContext,
  PrepareContext,
  RenderSystem,
  SystemBindings,
} from "../systems.ts";
import { geometrySignature, hashFloats, mix } from "./shadow_common.ts";

const GBUFFER_FORMAT: GPUTextureFormat = "rgba32float";
const AO_FORMAT: GPUTextureFormat = "rg16float";
/** Longest sample distance, in half-resolution pixels. */
const MAX_RADIUS_PX = 80;
/** Contrast of the visibility curve. */
const POWER = 1.6;

interface Kit {
  layout: GPUBindGroupLayout;
  prepass: GPURenderPipeline;
  gtao: GPURenderPipeline;
  blurH: GPURenderPipeline;
  blurV: GPURenderPipeline;
}
const kits = new WeakMap<GPUDevice, Kit>();

function kitOf(core: Core): Kit {
  let kit = kits.get(core.device);
  if (kit) return kit;
  const { device, pipelines } = core;
  const F = ShaderStage.FRAGMENT;
  const unfilterable: GPUTextureBindingLayout = {
    sampleType: "unfilterable-float",
  };
  const layout = device.createBindGroupLayout({
    label: "ao",
    entries: [
      { binding: 0, visibility: F, buffer: { type: "uniform" } },
      { binding: 1, visibility: F, texture: unfilterable },
      { binding: 2, visibility: F, texture: { sampleType: "float" } },
      { binding: 3, visibility: F, texture: unfilterable },
    ],
  });
  const prepassModule = device.createShaderModule({
    label: "ao-prepass",
    code: aoPrepassShader,
  });
  const prepass = device.createRenderPipeline({
    label: "ao-prepass",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [
        pipelines.frameLayout,
        pipelines.materialLayout,
        pipelines.instanceLayout,
      ],
    }),
    vertex: {
      module: prepassModule,
      entryPoint: "vs",
      buffers: [{
        arrayStride: VERTEX_STRIDE,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" },
          { shaderLocation: 1, offset: 12, format: "float32x3" },
          { shaderLocation: 2, offset: 24, format: "float32x2" },
          { shaderLocation: 3, offset: 32, format: "float32x4" },
        ],
      }],
    },
    fragment: {
      module: prepassModule,
      entryPoint: "fs",
      targets: [{ format: GBUFFER_FORMAT }],
    },
    primitive: { cullMode: "none" },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: true,
      depthCompare: "less",
    },
  });
  const module = device.createShaderModule({ label: "ao", code: aoShader });
  const fullscreen = (label: string, entry: string) =>
    device.createRenderPipeline({
      label,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: entry,
        targets: [{ format: AO_FORMAT }],
      },
    });
  kit = {
    layout,
    prepass,
    gtao: fullscreen("gtao", "fsAo"),
    blurH: fullscreen("ao-blur-h", "fsBlurH"),
    blurV: fullscreen("ao-blur-v", "fsBlurV"),
  };
  kits.set(device, kit);
  return kit;
}

export class AmbientOcclusionSystem implements RenderSystem {
  readonly name = "ambient-occlusion";
  private active = false;
  private width = 0;
  private height = 0;
  private textures: GPUTexture[] = [];
  private gbuffer?: GPUTextureView;
  private depth?: GPUTextureView;
  private a?: GPUTextureView;
  private b?: GPUTextureView;
  private groups?: {
    gtao: GPUBindGroup;
    blurH: GPUBindGroup;
    blurV: GPUBindGroup;
  };
  private params?: GPUBuffer;
  private signature = 0;

  prepare(ctx: PrepareContext) {
    this.active = false;
    if (
      ctx.quality !== "high" || ctx.environment.ambientOcclusion <= 0 ||
      ctx.overlays.shading === "wireframe" || ctx.overlays.shading === "unlit"
    ) return;
    this.ensure(ctx.core, Math.ceil(ctx.width / 2), Math.ceil(ctx.height / 2));
    ctx.write("systems", [1], 1);
    this.active = true;
  }

  bindings(): SystemBindings {
    return this.active ? { ao: this.a } : {};
  }

  encode(ctx: FrameContext): number {
    if (!this.active) return 0;
    const { camera, environment } = ctx;
    const signature = mix(
      hashFloats(
        mix(geometrySignature(ctx.plan), this.width * 8191 + this.height),
        [...camera.view, ...camera.projection, environment.aoRadius],
      ),
      camera.orthographic ? 1 : 0,
    ) || 1;
    if (signature === this.signature) return 0;
    this.signature = signature;

    const kit = kitOf(ctx.core);
    const p = camera.projection;
    const ortho = camera.orthographic;
    const params = new Float32Array(32);
    params.set(camera.view, 0);
    params.set([p[0], p[5], ortho ? p[12] : 0, ortho ? p[13] : 0], 16);
    params.set([this.width, this.height, 0, 0], 20);
    params.set([environment.aoRadius, ortho ? 1 : 0, MAX_RADIUS_PX, POWER], 24);
    ctx.core.device.queue.writeBuffer(this.params!, 0, params);

    const pre = ctx.encoder.beginRenderPass({
      colorAttachments: [{
        view: this.gbuffer!,
        clearValue: [0, 0, 0, 0],
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: this.depth!,
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });
    pre.setPipeline(kit.prepass);
    pre.setBindGroup(0, ctx.neutralGroup);
    drawPlan(pre, ctx, {
      filter: (b) => b.alphaMode !== "blend" && b.alphaMode !== "additive",
    });
    pre.end();

    const fullscreen = (
      pipeline: GPURenderPipeline,
      group: GPUBindGroup,
      target: GPUTextureView,
    ) => {
      const pass = ctx.encoder.beginRenderPass({
        colorAttachments: [{
          view: target,
          clearValue: [1, 0, 0, 1],
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    };
    const g = this.groups!;
    fullscreen(kit.gtao, g.gtao, this.a!);
    fullscreen(kit.blurH, g.blurH, this.b!);
    fullscreen(kit.blurV, g.blurV, this.a!);
    return 4;
  }

  private ensure(core: Core, width: number, height: number) {
    if (this.width === width && this.height === height && this.groups) return;
    this.release();
    this.width = width;
    this.height = height;
    this.signature = 0;
    const { device } = core;
    const make = (
      label: string,
      format: GPUTextureFormat,
      usage: number,
    ) => {
      const t = device.createTexture({
        label,
        size: [width, height],
        format,
        usage: TextureUsage.RENDER_ATTACHMENT | usage,
      });
      this.textures.push(t);
      return t.createView();
    };
    this.gbuffer = make(
      "ao-gbuffer",
      GBUFFER_FORMAT,
      TextureUsage.TEXTURE_BINDING,
    );
    this.depth = make("ao-depth", DEPTH_FORMAT, 0);
    this.a = make("ao-a", AO_FORMAT, TextureUsage.TEXTURE_BINDING);
    this.b = make("ao-b", AO_FORMAT, TextureUsage.TEXTURE_BINDING);
    this.params ??= device.createBuffer({
      label: "ao-params",
      size: 128,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    const kit = kitOf(core);
    const group = (source: GPUTextureView) =>
      device.createBindGroup({
        layout: kit.layout,
        entries: [
          { binding: 0, resource: { buffer: this.params! } },
          { binding: 1, resource: this.gbuffer! },
          { binding: 2, resource: core.dummies.blueNoise },
          { binding: 3, resource: source },
        ],
      });
    this.groups = {
      gtao: group(core.dummies.black),
      blurH: group(this.a),
      blurV: group(this.b),
    };
  }

  private release() {
    for (const t of this.textures) t.destroy();
    this.textures = [];
    this.groups = undefined;
  }

  dispose() {
    this.release();
    this.params?.destroy();
  }
}
