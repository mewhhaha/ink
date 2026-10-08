/** Pipelines and layouts of the post chain, created once per renderer. */
import { COLOR_FORMAT, ShaderStage } from "../gpu.ts";
import { decodeShader } from "../shaders/hdr.ts";
import { bloomShader } from "../shaders/post_bloom.ts";
import { exposureShader } from "../shaders/post_exposure.ts";
import { tonemapShader } from "../shaders/post_tonemap.ts";

const F = ShaderStage.FRAGMENT;

export interface PostPipelines {
  decodeLayout: GPUBindGroupLayout;
  decode: GPURenderPipeline;
  /** src (unfilterable) only: luma and reduce passes. */
  reduceLayout: GPUBindGroupLayout;
  luma: GPURenderPipeline;
  reduce: GPURenderPipeline;
  adaptLayout: GPUBindGroupLayout;
  adapt: GPURenderPipeline;
  bloomLayout: GPUBindGroupLayout;
  bloomDownKaris: GPURenderPipeline;
  bloomDown: GPURenderPipeline;
  /** Blends with the constant set by `setBlendConstant`. */
  bloomUp: GPURenderPipeline;
  tonemapLayout: GPUBindGroupLayout;
  tonemap: GPURenderPipeline;
  sampler: GPUSampler;
}

export function createPostPipelines(device: GPUDevice): PostPipelines {
  const layout = (label: string, entries: GPUBindGroupLayoutEntry[]) =>
    device.createBindGroupLayout({ label, entries });
  const pl = (l: GPUBindGroupLayout) =>
    device.createPipelineLayout({ bindGroupLayouts: [l] });
  const unfilterable: GPUTextureBindingLayout = {
    sampleType: "unfilterable-float",
  };

  const decodeLayout = layout("post-decode", [
    { binding: 0, visibility: F, texture: unfilterable },
    { binding: 1, visibility: F, texture: unfilterable },
  ]);
  const reduceLayout = layout("post-reduce", [
    { binding: 0, visibility: F, texture: unfilterable },
  ]);
  const adaptLayout = layout("post-adapt", [
    { binding: 0, visibility: F, texture: unfilterable },
    { binding: 1, visibility: F, texture: unfilterable },
    { binding: 2, visibility: F, buffer: { type: "uniform" } },
  ]);
  const bloomLayout = layout("post-bloom", [
    { binding: 0, visibility: F, texture: { sampleType: "float" } },
    { binding: 1, visibility: F, sampler: { type: "filtering" } },
  ]);
  const tonemapLayout = layout("post-tonemap", [
    { binding: 0, visibility: F, texture: unfilterable },
    { binding: 1, visibility: F, texture: { sampleType: "float" } },
    { binding: 2, visibility: F, texture: unfilterable },
    { binding: 3, visibility: F, texture: unfilterable },
    { binding: 4, visibility: F, buffer: { type: "uniform" } },
    { binding: 5, visibility: F, texture: { sampleType: "float" } },
    { binding: 6, visibility: F, sampler: { type: "filtering" } },
    { binding: 7, visibility: F, texture: unfilterable },
  ]);

  const pipeline = (
    label: string,
    code: string,
    fragment: string,
    bindLayout: GPUBindGroupLayout,
    target: GPUColorTargetState,
  ) => {
    const module = device.createShaderModule({ label, code });
    return device.createRenderPipeline({
      label,
      layout: pl(bindLayout),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: fragment, targets: [target] },
    });
  };
  const hdr: GPUColorTargetState = { format: COLOR_FORMAT };
  const blendConstant: GPUBlendComponent = {
    srcFactor: "constant",
    dstFactor: "one-minus-constant",
    operation: "add",
  };

  return {
    decodeLayout,
    decode: pipeline("post-decode", decodeShader, "fs", decodeLayout, hdr),
    reduceLayout,
    luma: pipeline("post-luma", exposureShader, "fsLuma", reduceLayout, {
      format: "rg32float",
    }),
    reduce: pipeline("post-reduce", exposureShader, "fsReduce", reduceLayout, {
      format: "rg32float",
    }),
    adaptLayout,
    adapt: pipeline("post-adapt", exposureShader, "fsAdapt", adaptLayout, {
      format: "r32float",
    }),
    bloomLayout,
    bloomDownKaris: pipeline(
      "bloom-down-karis",
      bloomShader,
      "fsDownKaris",
      bloomLayout,
      hdr,
    ),
    bloomDown: pipeline("bloom-down", bloomShader, "fsDown", bloomLayout, hdr),
    bloomUp: pipeline("bloom-up", bloomShader, "fsUp", bloomLayout, {
      format: COLOR_FORMAT,
      blend: { color: blendConstant, alpha: blendConstant },
    }),
    tonemapLayout,
    tonemap: pipeline("post-tonemap", tonemapShader, "fs", tonemapLayout, hdr),
    sampler: device.createSampler({
      label: "post",
      magFilter: "linear",
      minFilter: "linear",
    }),
  };
}
