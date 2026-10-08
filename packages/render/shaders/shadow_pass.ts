/** Depth-only shader of every shadow map pass. Group 0 is a dynamic-offset
 * uniform with the pass's view-projection matrix (one 256-byte slot per
 * pass); groups 1 (material, unused) and 2 (instances) are the plan's. */
import { instanceWgsl } from "./instance.ts";

export const shadowPassShader = /* wgsl */ `
struct ShadowPass { viewProj: mat4x4f }
@group(0) @binding(0) var<uniform> shadowPass: ShadowPass;
${instanceWgsl}
@group(1) @binding(0) var materialSampler: sampler;
@group(1) @binding(1) var baseTexture: texture_2d<f32>;

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) alpha: f32,
  @location(2) @interpolate(flat) inst: u32,
}
@vertex fn vs(@location(0) pos: vec3f, @location(2) uv: vec2f, @location(3) color: vec4f, @builtin(instance_index) i: u32) -> VOut {
  var out: VOut;
  out.clip = shadowPass.viewProj * (instances[i].model * vec4f(pos, 1.0));
  out.uv = uv * instances[i].params.yz;
  out.alpha = color.a * instances[i].color.a;
  out.inst = i;
  return out;
}
@fragment fn fs(v: VOut) {
  clipAlpha(instances[v.inst], v.alpha * textureSampleLevel(baseTexture, materialSampler, v.uv, 0.0).a);
}
`;
