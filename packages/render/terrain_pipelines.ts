/** Layouts, samplers, the shared patch index buffer and the pipelines of the
 * terrain passes, created lazily once per device. */
import type { Core } from "./core.ts";
import {
  BufferUsage,
  COLOR_FORMAT,
  DEPTH_FORMAT,
  SAMPLES,
  ShaderStage,
} from "./gpu.ts";
import {
  PATCH_CELLS,
  PATCH_INDICES,
  terrainMotionShader,
  terrainShader,
  terrainShadowShader,
} from "./shaders/terrain.ts";

const V = ShaderStage.VERTEX, F = ShaderStage.FRAGMENT, C = ShaderStage.COMPUTE;

/** Which pass a terrain is being drawn into. */
export type TerrainPass =
  | "lit"
  | "pick"
  | "ao"
  | "reflection"
  | "motion"
  | "shadow";

export interface TerrainKit {
  terrainLayout: GPUBindGroupLayout;
  nodesLayout: GPUBindGroupLayout;
  patchIndex: GPUBuffer;
  layerSampler: GPUSampler;
  mapSampler: GPUSampler;
  mip(format: GPUTextureFormat): GPURenderPipeline;
  pipeline(pass: TerrainPass): GPURenderPipeline;
}

const kits = new WeakMap<GPUDevice, TerrainKit>();

export function kitOf(core: Core): TerrainKit {
  let kit = kits.get(core.device);
  if (kit) return kit;
  const { device, pipelines } = core;
  const terrainLayout = device.createBindGroupLayout({
    label: "terrain",
    entries: [
      { binding: 0, visibility: V | F | C, buffer: { type: "uniform" } },
      {
        binding: 1,
        visibility: V | F | C,
        texture: { sampleType: "unfilterable-float" },
      },
      { binding: 2, visibility: F, texture: { sampleType: "float" } },
      {
        binding: 3,
        visibility: F,
        texture: { sampleType: "float", viewDimension: "2d-array" },
      },
      {
        binding: 4,
        visibility: F,
        texture: { sampleType: "float", viewDimension: "2d-array" },
      },
      {
        binding: 5,
        visibility: F,
        texture: { sampleType: "float", viewDimension: "2d-array" },
      },
      { binding: 6, visibility: F, sampler: { type: "filtering" } },
      { binding: 7, visibility: F, sampler: { type: "filtering" } },
    ],
  });
  const nodesLayout = device.createBindGroupLayout({
    label: "terrain nodes",
    entries: [{
      binding: 0,
      visibility: V,
      buffer: { type: "read-only-storage" },
    }],
  });
  const motionLayout = device.createBindGroupLayout({
    label: "terrain motion",
    entries: [
      { binding: 0, visibility: V, buffer: { type: "uniform" } },
      { binding: 1, visibility: V | F, buffer: { type: "read-only-storage" } },
    ],
  });
  const shadowLayout = device.createBindGroupLayout({
    label: "terrain shadow pass",
    entries: [{
      binding: 0,
      visibility: V,
      buffer: { type: "uniform", hasDynamicOffset: true },
    }],
  });
  const emptyLayout = device.createBindGroupLayout({ entries: [] });

  const indices = new Uint32Array(PATCH_INDICES);
  const stride = PATCH_CELLS + 1;
  let n = 0;
  for (let j = 0; j < PATCH_CELLS; j++) {
    for (let i = 0; i < PATCH_CELLS; i++) {
      const a = j * stride + i, b = a + 1, c = a + stride, d = c + 1;
      indices.set([a, c, b, b, c, d], n);
      n += 6;
    }
  }
  const patchIndex = device.createBuffer({
    label: "terrain patch indices",
    size: indices.byteLength,
    usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(patchIndex, 0, indices);

  const modules = new Map<string, GPUShaderModule>();
  const moduleOf = (label: string, code: string) => {
    let m = modules.get(label);
    if (!m) modules.set(label, m = device.createShaderModule({ label, code }));
    return m;
  };
  const cache = new Map<TerrainPass, GPURenderPipeline>();
  const layoutOf = (...layouts: GPUBindGroupLayout[]) =>
    device.createPipelineLayout({ bindGroupLayouts: layouts });
  const depth = (write = true): GPUDepthStencilState => ({
    format: DEPTH_FORMAT,
    depthWriteEnabled: write,
    depthCompare: "less",
  });
  const make = (pass: TerrainPass): GPURenderPipeline => {
    const scene = () => moduleOf("terrain", terrainShader);
    const frame = pipelines.frameLayout;
    const sceneLayout = layoutOf(frame, terrainLayout, nodesLayout);
    const vertex = (module: GPUShaderModule): GPUVertexState => ({
      module,
      entryPoint: "vs",
    });
    const primitive: GPUPrimitiveState = { cullMode: "back" };
    switch (pass) {
      case "lit":
        return device.createRenderPipeline({
          label: "terrain",
          layout: sceneLayout,
          vertex: vertex(scene()),
          fragment: {
            module: scene(),
            entryPoint: "fs",
            targets: [{ format: COLOR_FORMAT }],
          },
          primitive,
          depthStencil: depth(),
          multisample: { count: SAMPLES },
        });
      case "pick":
        return device.createRenderPipeline({
          label: "terrain pick",
          layout: sceneLayout,
          vertex: vertex(scene()),
          fragment: {
            module: scene(),
            entryPoint: "fsPick",
            targets: [
              { format: "rg32uint" },
              { format: "rgba8unorm" },
              { format: "r32float" },
            ],
          },
          primitive,
          depthStencil: depth(),
        });
      case "ao":
        return device.createRenderPipeline({
          label: "terrain ao prepass",
          layout: sceneLayout,
          vertex: vertex(scene()),
          fragment: {
            module: scene(),
            entryPoint: "fsAo",
            targets: [{ format: "rgba32float" }],
          },
          primitive,
          depthStencil: depth(),
        });
      case "reflection":
        return device.createRenderPipeline({
          label: "terrain reflection prepass",
          layout: sceneLayout,
          vertex: vertex(scene()),
          fragment: {
            module: scene(),
            entryPoint: "fsReflection",
            targets: [
              { format: "rgba32float" },
              { format: COLOR_FORMAT },
              { format: COLOR_FORMAT },
            ],
          },
          primitive,
          depthStencil: depth(),
        });
      case "motion": {
        const module = moduleOf("terrain motion", terrainMotionShader);
        return device.createRenderPipeline({
          label: "terrain motion",
          layout: layoutOf(frame, terrainLayout, nodesLayout, motionLayout),
          vertex: vertex(module),
          fragment: {
            module,
            entryPoint: "fs",
            targets: [{ format: COLOR_FORMAT }],
          },
          primitive,
          depthStencil: depth(),
        });
      }
      case "shadow": {
        const module = moduleOf("terrain shadow", terrainShadowShader);
        return device.createRenderPipeline({
          label: "terrain shadow",
          layout: layoutOf(shadowLayout, terrainLayout, nodesLayout),
          vertex: vertex(module),
          fragment: { module, entryPoint: "fs", targets: [] },
          primitive: { cullMode: "none" },
          depthStencil: {
            ...depth(),
            depthBias: 2,
            depthBiasSlopeScale: 2,
          },
        });
      }
    }
  };
  void emptyLayout;
  kit = {
    terrainLayout,
    nodesLayout,
    patchIndex,
    layerSampler: device.createSampler({
      label: "terrain layers",
      addressModeU: "repeat",
      addressModeV: "repeat",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      maxAnisotropy: 8,
    }),
    mapSampler: device.createSampler({
      label: "terrain maps",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
    }),
    mip: (format) => pipelines.mip(format),
    pipeline(pass) {
      let p = cache.get(pass);
      if (!p) cache.set(pass, p = make(pass));
      return p;
    },
  };
  kits.set(device, kit);
  return kit;
}
