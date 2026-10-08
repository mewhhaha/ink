/** Depth-only shader of every shadow map pass. Group 0 is a dynamic-offset
 * uniform with the pass's view-projection matrix (one 256-byte slot per
 * pass); groups 1 (material, unused) and 2 (instances) are the plan's. */
import { instanceWgsl } from "./instance.ts";

export const shadowPassShader = /* wgsl */ `
struct ShadowPass { viewProj: mat4x4f }
@group(0) @binding(0) var<uniform> shadowPass: ShadowPass;
${instanceWgsl}

@vertex fn vs(@location(0) pos: vec3f, @builtin(instance_index) i: u32) -> @builtin(position) vec4f {
  return shadowPass.viewProj * (instances[i].model * vec4f(pos, 1.0));
}
`;
