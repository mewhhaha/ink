/** Every pipeline and bind group layout of a renderer, created once per device. */
import {
  COLOR_FORMAT,
  DEPTH_FORMAT,
  OVERLAY_FORMAT,
  SAMPLES,
  ShaderStage,
  VERTEX_STRIDE,
} from "./gpu.ts";
import { finalShader } from "./shaders/final.ts";
import { mipShader } from "./shaders/mip.ts";
import { overlayShader } from "./shaders/overlay.ts";
import { sceneShader } from "./shaders/scene.ts";

const V = ShaderStage.VERTEX, F = ShaderStage.FRAGMENT;

export const vertexLayout: GPUVertexBufferLayout = {
  arrayStride: VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "float32x3" },
    { shaderLocation: 2, offset: 24, format: "float32x2" },
    { shaderLocation: 3, offset: 32, format: "float32x4" },
    { shaderLocation: 4, offset: 48, format: "uint32" },
    { shaderLocation: 5, offset: 52, format: "uint32x4" },
    { shaderLocation: 6, offset: 68, format: "float32x4" },
    { shaderLocation: 7, offset: 84, format: "float32x2" },
    { shaderLocation: 8, offset: 92, format: "uint32x4" },
    { shaderLocation: 9, offset: 108, format: "float32x4" },
  ],
};

const alphaBlend: GPUBlendState = {
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
};

export interface Pipelines {
  frameLayout: GPUBindGroupLayout;
  materialLayout: GPUBindGroupLayout;
  instanceLayout: GPUBindGroupLayout;
  linesLayout: GPUBindGroupLayout;
  fillsLayout: GPUBindGroupLayout;
  gridLayout: GPUBindGroupLayout;
  finalLayout: GPUBindGroupLayout;
  sky: GPURenderPipeline;
  lit: GPURenderPipeline;
  litDouble: GPURenderPipeline;
  blend: GPURenderPipeline;
  blendDouble: GPURenderPipeline;
  additive: GPURenderPipeline;
  additiveDouble: GPURenderPipeline;
  /** Depth-only copy of the lit pass, pushed back so wire lines stay visible. */
  prepass: GPURenderPipeline;
  wire: GPURenderPipeline;
  pick: GPURenderPipeline;
  pickDouble: GPURenderPipeline;
  mask: GPURenderPipeline;
  maskDouble: GPURenderPipeline;
  lines: GPURenderPipeline;
  linesOverlay: GPURenderPipeline;
  fills: GPURenderPipeline;
  grid: GPURenderPipeline;
  final: GPURenderPipeline;
  mip: (format: GPUTextureFormat) => GPURenderPipeline;
  mipLayout: GPUBindGroupLayout;
}

export function createPipelines(
  device: GPUDevice,
  outputFormat: GPUTextureFormat,
): Pipelines {
  const layout = (label: string, entries: GPUBindGroupLayoutEntry[]) =>
    device.createBindGroupLayout({ label, entries });

  // Group 0 of every scene pipeline; the table in README.md documents it.
  const frameLayout = layout("frame", [
    { binding: 0, visibility: V | F, buffer: { type: "uniform" } },
    {
      binding: 1,
      visibility: F,
      texture: { sampleType: "depth", viewDimension: "2d-array" },
    },
    { binding: 2, visibility: F, sampler: { type: "comparison" } },
    { binding: 3, visibility: F, texture: { sampleType: "depth" } },
    {
      binding: 4,
      visibility: F,
      texture: { sampleType: "depth", viewDimension: "cube-array" },
    },
    { binding: 5, visibility: F, texture: { sampleType: "float" } },
    { binding: 6, visibility: F, sampler: { type: "filtering" } },
    {
      binding: 7,
      visibility: F,
      texture: { sampleType: "float", viewDimension: "cube" },
    },
    {
      binding: 8,
      visibility: F,
      texture: { sampleType: "float", viewDimension: "cube" },
    },
    { binding: 9, visibility: F, texture: { sampleType: "float" } },
    { binding: 10, visibility: F, texture: { sampleType: "float" } },
    { binding: 11, visibility: F, buffer: { type: "read-only-storage" } },
    { binding: 12, visibility: F, buffer: { type: "read-only-storage" } },
    { binding: 14, visibility: F, buffer: { type: "read-only-storage" } },
    { binding: 15, visibility: F, texture: { sampleType: "float" } },
    { binding: 16, visibility: F, buffer: { type: "read-only-storage" } },
    {
      binding: 13,
      visibility: F,
      texture: { sampleType: "depth", viewDimension: "2d-array" },
    },
  ]);
  const materialLayout = layout("material", [
    { binding: 0, visibility: F, sampler: { type: "filtering" } },
    { binding: 1, visibility: F, texture: { sampleType: "float" } },
    { binding: 2, visibility: F, texture: { sampleType: "float" } },
    { binding: 3, visibility: F, texture: { sampleType: "float" } },
    { binding: 4, visibility: F, texture: { sampleType: "float" } },
    { binding: 5, visibility: F, texture: { sampleType: "float" } },
    { binding: 6, visibility: F, sampler: { type: "filtering" } },
    { binding: 7, visibility: F, sampler: { type: "filtering" } },
    { binding: 8, visibility: F, sampler: { type: "filtering" } },
    { binding: 9, visibility: F, sampler: { type: "filtering" } },
  ]);
  const instanceLayout = layout("instances", [
    { binding: 0, visibility: V | F, buffer: { type: "read-only-storage" } },
    { binding: 1, visibility: V, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: V, buffer: { type: "read-only-storage" } },
  ]);
  const linesLayout = layout("lines", [
    { binding: 0, visibility: V, buffer: { type: "read-only-storage" } },
  ]);
  const fillsLayout = layout("fills", [
    { binding: 1, visibility: V, buffer: { type: "read-only-storage" } },
  ]);
  const gridLayout = layout("grid", [
    { binding: 2, visibility: F, buffer: { type: "uniform" } },
  ]);
  const finalLayout = layout("final", [
    {
      binding: 0,
      visibility: F,
      texture: { sampleType: "unfilterable-float" },
    },
    {
      binding: 1,
      visibility: F,
      texture: { sampleType: "unfilterable-float" },
    },
    { binding: 2, visibility: F, buffer: { type: "uniform" } },
    { binding: 3, visibility: F, texture: { sampleType: "float" } },
    {
      binding: 4,
      visibility: F,
      texture: { sampleType: "unfilterable-float" },
    },
  ]);
  const mipLayout = layout("mip", [
    { binding: 0, visibility: F, texture: { sampleType: "float" } },
    { binding: 1, visibility: F, sampler: { type: "filtering" } },
  ]);

  const pl = (...layouts: GPUBindGroupLayout[]) =>
    device.createPipelineLayout({ bindGroupLayouts: layouts });
  const meshLayout = pl(frameLayout, materialLayout, instanceLayout);

  const scene = device.createShaderModule({
    label: "scene",
    code: sceneShader,
  });
  const overlay = device.createShaderModule({
    label: "overlay",
    code: overlayShader,
  });
  const finalModule = device.createShaderModule({
    label: "final",
    code: finalShader,
  });
  const mipModule = device.createShaderModule({
    label: "mip",
    code: mipShader,
  });

  const depth = (
    write: boolean,
    compare: GPUCompareFunction,
    extra: Partial<GPUDepthStencilState> = {},
  ): GPUDepthStencilState => ({
    format: DEPTH_FORMAT,
    depthWriteEnabled: write,
    depthCompare: compare,
    ...extra,
  });
  const multisample = { count: SAMPLES };

  const sky = device.createRenderPipeline({
    label: "sky",
    layout: pl(frameLayout),
    vertex: { module: scene, entryPoint: "vsSky" },
    fragment: {
      module: scene,
      entryPoint: "fsSky",
      targets: [{ format: COLOR_FORMAT }],
    },
    depthStencil: depth(false, "always"),
    multisample,
  });

  const meshVertex: GPUVertexState = {
    module: scene,
    entryPoint: "vs",
    buffers: [vertexLayout],
  };
  const meshPipeline = (
    label: string,
    doubleSided: boolean,
    blend?: GPUBlendState,
  ) =>
    device.createRenderPipeline({
      label,
      layout: meshLayout,
      vertex: meshVertex,
      fragment: {
        module: scene,
        entryPoint: blend ? "fsTransparent" : "fs",
        targets: [{ format: COLOR_FORMAT, blend }],
      },
      primitive: { cullMode: doubleSided ? "none" : "back" },
      depthStencil: depth(!blend, "less"),
      multisample,
    });
  const lit = meshPipeline("lit", false);
  const litDouble = meshPipeline("lit-double-sided", true);
  const blend = meshPipeline("alpha-blend", false, alphaBlend);
  const blendDouble = meshPipeline(
    "alpha-blend-double-sided",
    true,
    alphaBlend,
  );
  const addBlend: GPUBlendState = {
    color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
    alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
  };
  const additive = meshPipeline("additive", false, addBlend);
  const additiveDouble = meshPipeline("additive-double-sided", true, addBlend);
  const prepass = device.createRenderPipeline({
    label: "prepass",
    layout: meshLayout,
    vertex: meshVertex,
    fragment: {
      module: scene,
      entryPoint: "fsWire",
      targets: [{ format: COLOR_FORMAT, writeMask: 0 }],
    },
    primitive: { cullMode: "back" },
    depthStencil: depth(true, "less", { depthBias: 3, depthBiasSlopeScale: 2 }),
    multisample,
  });
  const wire = device.createRenderPipeline({
    label: "wire",
    layout: meshLayout,
    vertex: meshVertex,
    fragment: {
      module: scene,
      entryPoint: "fsWire",
      targets: [{ format: COLOR_FORMAT }],
    },
    primitive: { topology: "line-list" },
    depthStencil: depth(false, "less-equal"),
    multisample,
  });
  const pickPipeline = (doubleSided: boolean) =>
    device.createRenderPipeline({
      label: doubleSided ? "pick-double-sided" : "pick",
      layout: meshLayout,
      vertex: meshVertex,
      fragment: {
        module: scene,
        entryPoint: "fsPick",
        targets: [{ format: "rg32uint" }, { format: "rgba8unorm" }, {
          format: "r32float",
        }],
      },
      primitive: { cullMode: doubleSided ? "none" : "back" },
      depthStencil: depth(true, "less"),
    });
  const pick = pickPipeline(false);
  const pickDouble = pickPipeline(true);
  const maskPipeline = (doubleSided: boolean) =>
    device.createRenderPipeline({
      label: doubleSided ? "mask-double-sided" : "mask",
      layout: meshLayout,
      vertex: meshVertex,
      fragment: {
        module: scene,
        entryPoint: "fsMask",
        targets: [{ format: "rg8unorm" }],
      },
      primitive: { cullMode: doubleSided ? "none" : "back" },
      depthStencil: depth(false, "less-equal"),
      multisample,
    });
  const mask = maskPipeline(false);
  const maskDouble = maskPipeline(true);

  const lineTargets: GPUColorTargetState[] = [{
    format: OVERLAY_FORMAT,
    blend: alphaBlend,
  }];
  const linePipeline = (label: string, compare: GPUCompareFunction) =>
    device.createRenderPipeline({
      label,
      layout: pl(frameLayout, linesLayout),
      vertex: { module: overlay, entryPoint: "vsLine" },
      fragment: { module: overlay, entryPoint: "fsLine", targets: lineTargets },
      depthStencil: depth(false, compare),
      multisample,
    });
  const lines = linePipeline("lines", "less-equal");
  const linesOverlay = linePipeline("lines-overlay", "always");
  const fills = device.createRenderPipeline({
    label: "fills",
    layout: pl(frameLayout, fillsLayout),
    vertex: { module: overlay, entryPoint: "vsFill" },
    fragment: { module: overlay, entryPoint: "fsFill", targets: lineTargets },
    depthStencil: depth(false, "less-equal"),
    multisample,
  });
  const grid = device.createRenderPipeline({
    label: "grid",
    layout: pl(frameLayout, gridLayout),
    vertex: { module: overlay, entryPoint: "vsGrid" },
    fragment: { module: overlay, entryPoint: "fsGrid", targets: lineTargets },
    depthStencil: depth(false, "less-equal"),
    multisample,
  });
  const final = device.createRenderPipeline({
    label: "final",
    layout: pl(finalLayout),
    vertex: { module: finalModule, entryPoint: "vs" },
    fragment: {
      module: finalModule,
      entryPoint: "fs",
      targets: [{ format: outputFormat }],
    },
  });

  const mipCache = new Map<GPUTextureFormat, GPURenderPipeline>();
  const mip = (format: GPUTextureFormat) => {
    let p = mipCache.get(format);
    if (!p) {
      p = device.createRenderPipeline({
        label: `mip-${format}`,
        layout: pl(mipLayout),
        vertex: { module: mipModule, entryPoint: "vs" },
        fragment: {
          module: mipModule,
          entryPoint: "fs",
          targets: [{ format }],
        },
      });
      mipCache.set(format, p);
    }
    return p;
  };

  return {
    frameLayout,
    materialLayout,
    instanceLayout,
    linesLayout,
    fillsLayout,
    gridLayout,
    finalLayout,
    sky,
    lit,
    litDouble,
    blend,
    blendDouble,
    additive,
    additiveDouble,
    prepass,
    wire,
    pick,
    pickDouble,
    mask,
    maskDouble,
    lines,
    linesOverlay,
    fills,
    grid,
    final,
    mip,
    mipLayout,
  };
}
