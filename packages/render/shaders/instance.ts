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
  skin: vec4u,      // palette offset/count, UV set bitmask, material flags
  surface: vec4f,   // x occlusion strength, y first lightmap chart + 1
  morph: vec4u,     // weights offset, targets offset, vertex count, target count
}
@group(2) @binding(0) var<storage, read> instances: array<Instance>;
struct Joint { matrix: mat4x4f, normal: mat4x4f }
@group(2) @binding(1) var<storage, read> joints: array<Joint>;
@group(2) @binding(2) var<storage, read> morphs: array<f32>;

fn morphDelta(inst: Instance, vertex: u32, componentOffset: u32) -> vec3f {
  var result = vec3f(0.0);
  for (var t = 0u; t < inst.morph.w; t++) {
    let base = inst.morph.y + (t * inst.morph.z + vertex) * 6u + componentOffset;
    result += vec3f(morphs[base], morphs[base + 1u], morphs[base + 2u]) * morphs[inst.morph.x + t];
  }
  return result;
}

fn skinPosition(inst: Instance, position: vec3f, indices: vec4u, weights: vec4f, indices1: vec4u, weights1: vec4f) -> vec4f {
  let p = vec4f(position, 1.0);
  if (inst.skin.y == 0u) { return p; }
  var result = vec4f(0.0);
  for (var i = 0u; i < 4u; i++) {
    result += (joints[inst.skin.x + indices[i]].matrix * p) * weights[i];
    result += (joints[inst.skin.x + indices1[i]].matrix * p) * weights1[i];
  }
  return result;
}
fn skinNormal(inst: Instance, normal: vec3f, indices: vec4u, weights: vec4f, indices1: vec4u, weights1: vec4f) -> vec3f {
  if (inst.skin.y == 0u) { return normalize(normal); }
  var result = vec3f(0.0);
  for (var i = 0u; i < 4u; i++) {
    result += (joints[inst.skin.x + indices[i]].normal * vec4f(normal, 0.0)).xyz * weights[i];
    result += (joints[inst.skin.x + indices1[i]].normal * vec4f(normal, 0.0)).xyz * weights1[i];
  }
  return normalize(result);
}
fn materialUv(inst: Instance, uv: vec2f, uv1: vec2f, slot: u32) -> vec2f {
  return select(uv, uv1, (inst.skin.z & (1u << slot)) != 0u);
}

fn clipAlpha(inst: Instance, alpha: f32) {
  if ((inst.ids.z == 1u && alpha < bitcast<f32>(inst.ids.w)) ||
      (inst.ids.z >= 2u && alpha <= 0.001)) { discard; }
}
`;
