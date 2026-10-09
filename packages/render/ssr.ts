import type { Core } from "./core.ts";
import {
  COLOR_FORMAT,
  DEPTH_FORMAT,
  ShaderStage,
  TextureUsage,
} from "./gpu.ts";
import { vertexLayout } from "./pipelines.ts";
import { sceneShader } from "./shaders/scene.ts";
import { ssrShader } from "./shaders/ssr.ts";
import { drawPlan, type FrameContext } from "./systems.ts";
import { drawWorld } from "./world.ts";

interface Kit {
  prepass: GPURenderPipeline;
  double: GPURenderPipeline;
  resolve: GPURenderPipeline;
  layout: GPUBindGroupLayout;
}
const kits = new WeakMap<GPUDevice, Kit>();
function kitOf(core: Core) {
  let kit = kits.get(core.device);
  if (kit) return kit;
  const { device, pipelines } = core;
  const module = device.createShaderModule({
    label: "reflection prepass",
    code: sceneShader,
  });
  const meshLayout = device.createPipelineLayout({
    bindGroupLayouts: [
      pipelines.frameLayout,
      pipelines.materialLayout,
      pipelines.instanceLayout,
    ],
  });
  const prepass = (cullMode: GPUCullMode) =>
    device.createRenderPipeline({
      label: "reflection surfaces",
      layout: meshLayout,
      vertex: { module, entryPoint: "vs", buffers: [vertexLayout] },
      fragment: {
        module,
        entryPoint: "fsReflection",
        targets: [
          { format: "rgba32float" },
          { format: COLOR_FORMAT },
          { format: COLOR_FORMAT },
        ],
      },
      primitive: { cullMode },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
  const layout = device.createBindGroupLayout({
    label: "screen reflections",
    entries: [0, 1, 2, 3].map((binding) => ({
      binding,
      visibility: ShaderStage.FRAGMENT,
      texture: { sampleType: binding === 1 ? "unfilterable-float" : "float" },
    })),
  });
  const resolveModule = device.createShaderModule({
    label: "screen-space reflections",
    code: ssrShader,
  });
  kit = {
    prepass: prepass("back"),
    double: prepass("none"),
    layout,
    resolve: device.createRenderPipeline({
      label: "screen-space reflection resolve",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [pipelines.frameLayout, layout],
      }),
      vertex: { module: resolveModule, entryPoint: "vs" },
      fragment: {
        module: resolveModule,
        entryPoint: "fs",
        targets: [{ format: COLOR_FORMAT }],
      },
    }),
  };
  kits.set(device, kit);
  return kit;
}

export class ScreenReflections {
  private textures: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private size = "";
  constructor(private core: Core) {}
  encode(ctx: FrameContext, frame: GPUBindGroup, color: GPUTextureView) {
    const { width, height, encoder } = ctx,
      { device } = this.core,
      kit = kitOf(this.core);
    if (this.size !== `${width}:${height}`) {
      this.dispose();
      this.size = `${width}:${height}`;
      for (
        const format of [
          "rgba32float",
          COLOR_FORMAT,
          COLOR_FORMAT,
          DEPTH_FORMAT,
          COLOR_FORMAT,
        ] as GPUTextureFormat[]
      ) {
        const texture = device.createTexture({
          label: "reflection screen data",
          size: [width, height],
          format,
          usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
        });
        this.textures.push(texture);
        this.views.push(texture.createView());
      }
    }
    const pass = encoder.beginRenderPass({
      label: "reflection surface prepass",
      colorAttachments: this.views.slice(0, 3).map((view) => ({
        view,
        loadOp: "clear",
        storeOp: "store",
      })),
      depthStencilAttachment: {
        view: this.views[3],
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });
    pass.setBindGroup(0, frame);
    drawPlan(pass, ctx, {
      filter: (b) => b.alphaMode !== "blend" && b.alphaMode !== "additive",
      pipeline: (b) => b.doubleSided ? kit.double : kit.prepass,
    });
    drawWorld(pass, ctx.core, ctx.plan.world, "reflection", 0, {
      scatter: (double) => double ? kit.double : kit.prepass,
    });
    pass.end();
    const resolve = encoder.beginRenderPass({
      label: "reflection ray march",
      colorAttachments: [{
        view: this.views[4],
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    resolve.setPipeline(kit.resolve);
    resolve.setBindGroup(0, frame);
    resolve.setBindGroup(
      1,
      device.createBindGroup({
        layout: kit.layout,
        entries: [color, ...this.views.slice(0, 3)]
          .map((resource, binding) => ({ binding, resource })),
      }),
    );
    resolve.draw(3);
    resolve.end();
    return this.views[4];
  }
  dispose() {
    for (const texture of this.textures) texture.destroy();
    this.textures = [];
    this.views = [];
    this.size = "";
  }
}
