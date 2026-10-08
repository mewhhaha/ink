/** The per-instance record of mesh draws (group 2), shared by the scene
 * shader and every pass that draws the plan with its own shader. */
export const instanceWgsl = /* wgsl */ `
struct Instance {
  model: mat4x4f,
  normalm: mat3x3f,
  color: vec4f,     // linear base colour
  emissive: vec4f,  // rgb linear emissive (strength applied), w roughness
  params: vec4f,    // x metallic, yz uv scale, w normal strength
  ids: vec4u,       // x entity id, y selection flags, z alpha mode, w cutoff bits
}
@group(2) @binding(0) var<storage, read> instances: array<Instance>;

fn clipAlpha(inst: Instance, alpha: f32) {
  if ((inst.ids.z == 1u && alpha < bitcast<f32>(inst.ids.w)) ||
      (inst.ids.z >= 2u && alpha <= 0.001)) { discard; }
}
`;
