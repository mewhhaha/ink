/**
 * GPU culling of scatter layers. One thread per resident placement builds the
 * instance (position on the terrain, yaw, scale, tint), tests it against the
 * camera frustum and up to four shadow cascades, the layer's distance limit
 * and (for the camera only) last frame's depth pyramid, picks a mesh level by
 * its projected error, and appends a complete `Instance` record (see
 * instance.ts) to the list and level it belongs in. Passes then draw each
 * level of each list with one indirect draw over a bind group that exposes
 * that range as the instance buffer, so every existing mesh shader works
 * unchanged.
 */
import { terrainFieldWgsl } from "./terrain.ts";

export const MAX_LISTS = 5;
export const MAX_LEVELS = 5;
export const INSTANCE_WORDS = 56;
export const CULL_WORKGROUP = 64;
/** Floats of the cull parameter block (see `CullParams`). */
export const CULL_PARAM_FLOATS = 16 * (MAX_LISTS + 1) + 4 * 12;

export const scatterCullShader = /* wgsl */ `
${terrainFieldWgsl}

struct CullParams {
  lists: array<mat4x4f, ${MAX_LISTS}>,   // clip matrices: camera, then the sun cascades
  previous: mat4x4f,                      // last frame's view-projection (occlusion)
  layer: vec4f,        // xyz layer origin, w 1 when placements follow the terrain
  camera: vec4f,       // xyz position, w near
  limits: vec4f,       // x list count, y placement count, z max distance, w pixels per unit
  occlusion: vec4f,    // x enabled, y hiz width, z hiz height, w far
  sphere: vec4f,       // local bounds centre xyz, radius
  color: vec4f,
  style: vec4f,        // x roughness, y metallic, z tint variation, w align to ground
  errors: vec4f,       // geometric error of levels 1..4 in mesh units
  ids: vec4u,          // x entity, y alpha mode, z cutoff bits, w level count
  caps: vec4u,         // x main capacity, y shadow capacity, z frustum culling on, w reserved
}
@group(0) @binding(0) var<uniform> cull: CullParams;
@group(0) @binding(1) var hiz: texture_2d<f32>;
@group(2) @binding(0) var<storage, read> placements: array<f32>;
@group(2) @binding(1) var<storage, read_write> records: array<u32>;
@group(2) @binding(2) var<storage, read_write> args: array<atomic<u32>>;

const LEVELS: u32 = ${MAX_LEVELS}u;

fn recordBase(list: u32, level: u32) -> u32 {
  let main = cull.caps.x;
  let shadow = cull.caps.y;
  let levels = cull.ids.w;
  if (list == 0u) { return level * main; }
  return levels * main + ((list - 1u) * levels + level) * shadow;
}

fn put(base: u32, k: u32, v: f32) { records[base + k] = bitcast<u32>(v); }

// A sphere against the planes of a clip matrix (the near plane is skipped for
// shadow cascades: casters in front of the map's near plane still shadow it).
fn inClip(m: mat4x4f, c: vec3f, r: f32, near: bool) -> bool {
  let p = vec4f(c, 1.0);
  let x = vec4f(m[0][0], m[1][0], m[2][0], m[3][0]);
  let y = vec4f(m[0][1], m[1][1], m[2][1], m[3][1]);
  let z = vec4f(m[0][2], m[1][2], m[2][2], m[3][2]);
  let w = vec4f(m[0][3], m[1][3], m[2][3], m[3][3]);
  var planes = array<vec4f, 6>(w + x, w - x, w + y, w - y, z, w - z);
  for (var i = 0u; i < 6u; i++) {
    if (i == 4u && !near) { continue; }
    let plane = planes[i];
    let n = length(plane.xyz);
    if (dot(plane, p) < -r * n) { return false; }
  }
  return true;
}

fn linearDepth(d: f32) -> f32 {
  let near = cull.camera.w;
  let far = cull.occlusion.w;
  return near * far / max(far - d * (far - near), 1e-6);
}

// Whether last frame's depth hides the whole sphere.
fn occluded(c: vec3f, r: f32) -> bool {
  if (cull.occlusion.x < 0.5) { return false; }
  var lo = vec2f(1e9);
  var hi = vec2f(-1e9);
  var nearest = 1e9;
  for (var i = 0u; i < 8u; i++) {
    let corner = c + vec3f(
      select(-r, r, (i & 1u) != 0u),
      select(-r, r, (i & 2u) != 0u),
      select(-r, r, (i & 4u) != 0u));
    let clip = cull.previous * vec4f(corner, 1.0);
    if (clip.w <= 0.0) { return false; }
    let ndc = clip.xy / clip.w;
    lo = min(lo, ndc);
    hi = max(hi, ndc);
    nearest = min(nearest, clip.w);
  }
  if (any(lo < vec2f(-1.0)) || any(hi > vec2f(1.0))) {
    lo = clamp(lo, vec2f(-1.0), vec2f(1.0));
    hi = clamp(hi, vec2f(-1.0), vec2f(1.0));
    if (any(lo >= hi)) { return false; }
  }
  let size = vec2f(cull.occlusion.y, cull.occlusion.z);
  let uvLo = vec2f(lo.x * 0.5 + 0.5, 0.5 - hi.y * 0.5) * size;
  let uvHi = vec2f(hi.x * 0.5 + 0.5, 0.5 - lo.y * 0.5) * size;
  let extent = max(uvHi.x - uvLo.x, uvHi.y - uvLo.y) + 2.0;
  let levels = i32(textureNumLevels(hiz));
  let level = clamp(i32(ceil(log2(max(extent, 1.0)))), 0, levels - 1);
  let dims = vec2i(textureDimensions(hiz, level));
  let a = clamp(vec2i(floor((uvLo - 1.0) / f32(1 << u32(level)))), vec2i(0), dims - 1);
  let b = clamp(vec2i(floor((uvHi + 1.0) / f32(1 << u32(level)))), vec2i(0), dims - 1);
  var farthest = 0.0;
  for (var y = a.y; y <= b.y; y++) {
    for (var x = a.x; x <= b.x; x++) {
      farthest = max(farthest, textureLoad(hiz, vec2i(x, y), level).r);
    }
  }
  // Everything under the rectangle is nearer than the sphere's nearest point.
  let wall = linearDepth(farthest);
  return nearest > wall + 0.5 + 0.02 * wall;
}

@compute @workgroup_size(${CULL_WORKGROUP})
fn cullInstances(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= u32(cull.limits.y)) { return; }
  let o = index * 6u;
  let local = vec3f(placements[o], placements[o + 1u], placements[o + 2u]);
  let yaw = placements[o + 3u];
  let scale = placements[o + 4u];
  let tint = placements[o + 5u];

  var position = cull.layer.xyz + local;
  var up = vec3f(0.0, 1.0, 0.0);
  if (cull.layer.w > 0.5) {
    let at = position.xz - terrain.origin.xz;
    position.y = cull.layer.y + terrain.origin.y + baseHeight(at) + detailHeight(at, 1.0) + local.y;
    if (cull.style.w > 0.0) {
      let cs = terrain.field.x / terrain.field.y;
      let dx = baseHeight(at + vec2f(cs, 0.0)) - baseHeight(at - vec2f(cs, 0.0));
      let dz = baseHeight(at + vec2f(0.0, cs)) - baseHeight(at - vec2f(0.0, cs));
      up = normalize(mix(vec3f(0.0, 1.0, 0.0), normalize(vec3f(-dx, 2.0 * cs, -dz)), cull.style.w));
    }
  }
  let center = position + cull.sphere.xyz * scale;
  let radius = cull.sphere.w * scale;
  let toCamera = center - cull.camera.xyz;
  let distance = length(toCamera);
  if (distance - radius > cull.limits.z) { return; }

  // Level: the coarsest whose error projects to under a pixel and a half.
  var level = 0u;
  let levels = cull.ids.w;
  let unit = scale * cull.limits.w / max(distance - radius, 0.1);
  for (var l = levels - 1u; l >= 1u; l--) {
    if (cull.errors[l - 1u] * unit <= 1.5) { level = l; break; }
  }

  // Which lists want it.
  var wanted = 0u;
  for (var l = 0u; l < u32(cull.limits.x); l++) {
    var visible = true;
    if (cull.caps.z != 0u) { visible = inClip(cull.lists[l], center, radius, l == 0u); }
    if (visible && l == 0u && cull.caps.z == 2u && occluded(center, radius)) { visible = false; }
    if (visible) { wanted |= 1u << l; }
  }
  if (wanted == 0u) { return; }

  // The instance: rotation (yaw, then tilt to the ground), scale, translation.
  let cy = cos(yaw);
  let sy = sin(yaw);
  var rx = vec3f(cy, 0.0, -sy);
  var ry = vec3f(0.0, 1.0, 0.0);
  var rz = vec3f(sy, 0.0, cy);
  if (up.y < 0.99999) {
    let axis = normalize(cross(vec3f(0.0, 1.0, 0.0), up));
    let c = up.y;
    let s = sqrt(max(0.0, 1.0 - c * c));
    let k = 1.0 - c;
    let tilt = mat3x3f(
      vec3f(c + axis.x * axis.x * k, axis.z * s + axis.x * axis.y * k, -axis.y * s + axis.x * axis.z * k),
      vec3f(-axis.z * s + axis.x * axis.y * k, c + axis.y * axis.y * k, axis.x * s + axis.y * axis.z * k),
      vec3f(axis.y * s + axis.x * axis.z * k, -axis.x * s + axis.y * axis.z * k, c + axis.z * axis.z * k));
    rx = tilt * rx;
    ry = tilt * ry;
    rz = tilt * rz;
  }
  let brightness = 1.0 + cull.style.z * (tint - 0.5) * 2.0;
  let color = vec4f(cull.color.rgb * brightness, cull.color.a);

  for (var l = 0u; l < u32(cull.limits.x); l++) {
    if ((wanted & (1u << l)) == 0u) { continue; }
    let capacity = select(cull.caps.y, cull.caps.x, l == 0u);
    let slot = atomicAdd(&args[(l * levels + level) * 5u + 1u], 1u);
    if (slot >= capacity) { continue; }
    let b = (recordBase(l, level) + slot) * ${INSTANCE_WORDS}u;
    put(b, 0u, rx.x * scale); put(b, 1u, rx.y * scale); put(b, 2u, rx.z * scale); put(b, 3u, 0.0);
    put(b, 4u, ry.x * scale); put(b, 5u, ry.y * scale); put(b, 6u, ry.z * scale); put(b, 7u, 0.0);
    put(b, 8u, rz.x * scale); put(b, 9u, rz.y * scale); put(b, 10u, rz.z * scale); put(b, 11u, 0.0);
    put(b, 12u, position.x); put(b, 13u, position.y); put(b, 14u, position.z); put(b, 15u, 1.0);
    // Normal matrix: the rotation (the shader normalises).
    put(b, 16u, rx.x); put(b, 17u, rx.y); put(b, 18u, rx.z); put(b, 19u, 0.0);
    put(b, 20u, ry.x); put(b, 21u, ry.y); put(b, 22u, ry.z); put(b, 23u, 0.0);
    put(b, 24u, rz.x); put(b, 25u, rz.y); put(b, 26u, rz.z); put(b, 27u, 0.0);
    put(b, 28u, color.r); put(b, 29u, color.g); put(b, 30u, color.b); put(b, 31u, color.a);
    put(b, 32u, 0.0); put(b, 33u, 0.0); put(b, 34u, 0.0); put(b, 35u, cull.style.x);
    put(b, 36u, cull.style.y); put(b, 37u, 1.0); put(b, 38u, 1.0); put(b, 39u, 1.0);
    records[b + 40u] = cull.ids.x;
    records[b + 41u] = 0u;
    records[b + 42u] = cull.ids.y;
    records[b + 43u] = cull.ids.z;
    records[b + 44u] = 0u; records[b + 45u] = 0u; records[b + 46u] = 0u; records[b + 47u] = 0u;
    put(b, 48u, 1.0); put(b, 49u, 0.0); put(b, 50u, 0.0); put(b, 51u, 0.0);
    records[b + 52u] = 0u; records[b + 53u] = 0u; records[b + 54u] = 0u; records[b + 55u] = 0u;
  }
}

// Instances beyond a list's capacity were counted but not stored: clamp the
// counts the indirect draws read.
@compute @workgroup_size(1)
fn clampArgs(@builtin(global_invocation_id) id: vec3u) {
  let levels = cull.ids.w;
  let list = id.x;
  if (list >= u32(cull.limits.x)) { return; }
  let capacity = select(cull.caps.y, cull.caps.x, list == 0u);
  for (var l = 0u; l < levels; l++) {
    let at = (list * levels + l) * 5u + 1u;
    atomicMin(&args[at], capacity);
  }
}
`;

/** Depth pyramid: level 0 takes the farthest of every 2x2 pixels (and the
 * four samples of each); later levels the farthest of 2x2 texels. */
export const hizShader = /* wgsl */ `
@group(0) @binding(0) var depth: texture_depth_multisampled_2d;
@group(0) @binding(1) var target0: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8)
fn init(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2u(textureDimensions(target0));
  if (id.x >= size.x || id.y >= size.y) { return; }
  let source = vec2i(textureDimensions(depth));
  var farthest = 0.0;
  for (var y = 0; y < 2; y++) {
    for (var x = 0; x < 2; x++) {
      let p = min(vec2i(id.xy) * 2 + vec2i(x, y), source - 1);
      for (var s = 0; s < 4; s++) {
        farthest = max(farthest, textureLoad(depth, p, s));
      }
    }
  }
  textureStore(target0, id.xy, vec4f(farthest));
}
`;

export const hizDownShader = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var target0: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8)
fn down(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2u(textureDimensions(target0));
  if (id.x >= size.x || id.y >= size.y) { return; }
  let extent = vec2i(textureDimensions(source));
  var farthest = 0.0;
  for (var y = 0; y < 2; y++) {
    for (var x = 0; x < 2; x++) {
      let p = min(vec2i(id.xy) * 2 + vec2i(x, y), extent - 1);
      farthest = max(farthest, textureLoad(source, p, 0).r);
    }
  }
  textureStore(target0, id.xy, vec4f(farthest));
}
`;
