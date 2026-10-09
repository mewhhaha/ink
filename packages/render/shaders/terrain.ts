/**
 * Terrain shaders. A terrain is drawn as a quadtree of square patches, each a
 * 32x32 quad grid positioned by a node record. Vertices fetch their height
 * from the heightmap texture and morph towards the next coarser grid as they
 * approach the distance at which the quadtree merges them (CDLOD), so levels
 * meet without cracks. Fragments take the slope from a prefiltered slope
 * texture, blend up to eight splat layers (with height-based blending) and
 * shade through the same `shadeSurface` as meshes.
 *
 * Bindings (shared by every terrain pass):
 *   group 1  terrain data: uniform, height (r32float), slopes (rg16float,
 *            mips), splat weights (rgba8 array, 4 layers per plane), layer
 *            albedo / data arrays, two samplers
 *   group 2  nodes: [0] camera position, [1 + i] x, z, size (m), level
 */
import { aoWgsl } from "./ao.ts";
import { common } from "./common.ts";
import { environmentWgsl } from "./environment.ts";
import { hdrWgsl } from "./hdr.ts";
import { lightingWgsl } from "./lighting.ts";
import { lightmapWgsl } from "./lightmaps.ts";
import { probeWgsl } from "./probes.ts";
import { shadowsWgsl } from "./shadows.ts";

/** Quads per patch side. */
export const PATCH_CELLS = 32;
export const PATCH_INDICES = PATCH_CELLS * PATCH_CELLS * 6;
export const MAX_TERRAIN_LAYERS = 8;
/** Floats of the terrain uniform: 4 vec4 + one vec4 per layer. */
export const TERRAIN_UNIFORM_FLOATS = 16 + MAX_TERRAIN_LAYERS * 4;

/** The terrain field: bindings, noise and height functions. Also used by the
 * scatter culling, which brings its own group 2. */
export const terrainFieldWgsl = /* wgsl */ `
const PATCH: f32 = ${PATCH_CELLS}.0;
const PATCH_U: u32 = ${PATCH_CELLS}u;

struct TerrainU {
  origin: vec4f,    // xyz centre of the terrain, w entity id (u32 bits)
  field: vec4f,     // x size (m), y cells, z height scale, w lod factor
  detail: vec4f,    // amplitude (m), wavelength (m), octaves, seed
  layers: vec4f,    // x layer count, y blend height, z splat planes, w reserved
  layer: array<vec4f, ${MAX_TERRAIN_LAYERS}>, // rgb tint, w 1 / tiling
}
@group(1) @binding(0) var<uniform> terrain: TerrainU;
@group(1) @binding(1) var heightTexture: texture_2d<f32>;
@group(1) @binding(2) var slopeTexture: texture_2d<f32>;
@group(1) @binding(3) var splatTexture: texture_2d_array<f32>;
@group(1) @binding(4) var albedoLayers: texture_2d_array<f32>;
@group(1) @binding(5) var dataLayers: texture_2d_array<f32>;
@group(1) @binding(6) var layerSampler: sampler;
@group(1) @binding(7) var mapSampler: sampler;

// ink/noise perlin3 / fbm2 (packages/blot/lib/noise.blot), word for word.
fn nHash3(x: u32, y: u32, z: u32, seed: u32) -> u32 {
  var h = (x * 2747636419u) ^ (y * 2654435769u) ^ (z * 2246822519u) ^ (seed * 3266489917u);
  h = h ^ (h >> 15u);
  h = h * 2246822507u;
  h = h ^ (h >> 13u);
  h = h * 3266489909u;
  return h ^ (h >> 16u);
}
fn nGradient(h: u32, x: f32, y: f32, z: f32) -> f32 {
  let k = h % 12u;
  let u = select(y, x, k < 8u);
  let v = select(z, y, k < 4u);
  let a = select(-u, u, (k & 1u) == 0u);
  let b = select(-v, v, (k & 2u) == 0u);
  return a + b;
}
fn nFade(t: f32) -> f32 { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
fn nCell(v: f32) -> u32 { return bitcast<u32>(i32(floor(v))); }
fn perlin3(seed: u32, p: vec3f) -> f32 {
  let xi = nCell(p.x); let yi = nCell(p.y); let zi = nCell(p.z);
  let f = p - floor(p);
  let g000 = nGradient(nHash3(xi, yi, zi, seed), f.x, f.y, f.z);
  let g100 = nGradient(nHash3(xi + 1u, yi, zi, seed), f.x - 1.0, f.y, f.z);
  let g010 = nGradient(nHash3(xi, yi + 1u, zi, seed), f.x, f.y - 1.0, f.z);
  let g110 = nGradient(nHash3(xi + 1u, yi + 1u, zi, seed), f.x - 1.0, f.y - 1.0, f.z);
  let g001 = nGradient(nHash3(xi, yi, zi + 1u, seed), f.x, f.y, f.z - 1.0);
  let g101 = nGradient(nHash3(xi + 1u, yi, zi + 1u, seed), f.x - 1.0, f.y, f.z - 1.0);
  let g011 = nGradient(nHash3(xi, yi + 1u, zi + 1u, seed), f.x, f.y - 1.0, f.z - 1.0);
  let g111 = nGradient(nHash3(xi + 1u, yi + 1u, zi + 1u, seed), f.x - 1.0, f.y - 1.0, f.z - 1.0);
  let u = nFade(f.x); let v = nFade(f.y); let w = nFade(f.z);
  let x00 = mix(g000, g100, u); let x10 = mix(g010, g110, u);
  let x01 = mix(g001, g101, u); let x11 = mix(g011, g111, u);
  return mix(mix(x00, x10, v), mix(x01, x11, v), w);
}

// Procedural detail height at a terrain-local position. Octaves whose
// wavelength is under four grid spacings fade out (to nothing at two), which
// keeps the surface from shimmering when a patch is coarse; the CPU and
// Blot evaluate every octave.
fn detailHeight(local: vec2f, spacing: f32) -> f32 {
  let amplitude = terrain.detail.x;
  let octaves = u32(terrain.detail.z);
  if (amplitude == 0.0 || octaves == 0u) { return 0.0; }
  let seed = bitcast<u32>(terrain.detail.w);
  let q = local / max(terrain.detail.y, 0.001);
  var sum = 0.0;
  var total = 0.0;
  var weight = 1.0;
  var frequency = 1.0;
  for (var o = 0u; o < octaves; o++) {
    let wavelength = terrain.detail.y / frequency;
    let fade = clamp((wavelength / spacing - 2.0) * 0.5, 0.0, 1.0);
    if (fade > 0.0) {
      sum += weight * fade * perlin3(seed + o * 101u, vec3f(q * frequency, 0.5));
    }
    total += weight;
    weight *= 0.5;
    frequency *= 2.0;
  }
  return amplitude * sum / total;
}

fn heightLoad(i: vec2i) -> f32 {
  let m = i32(terrain.field.y);
  return textureLoad(heightTexture, clamp(i, vec2i(0), vec2i(m)), 0).r;
}

// Bilinear height of the stored field (metres, scale applied).
fn baseHeight(local: vec2f) -> f32 {
  let cells = terrain.field.y;
  let c = clamp((local / terrain.field.x + 0.5) * cells, vec2f(0.0), vec2f(cells));
  let i = min(floor(c), vec2f(cells - 1.0));
  let f = c - i;
  let p = vec2i(i);
  let h = mix(
    mix(heightLoad(p), heightLoad(p + vec2i(1, 0)), f.x),
    mix(heightLoad(p + vec2i(0, 1)), heightLoad(p + vec2i(1, 1)), f.x),
    f.y);
  return h * terrain.field.z;
}

`;

/** Geometry stage shared by every pass; it reads no frame data. */
export const terrainGeometryWgsl = /* wgsl */ `
${terrainFieldWgsl}
@group(2) @binding(0) var<storage, read> nodes: array<vec4f>;

struct TerrainVertex {
  world: vec3f,
  local: vec2f,
  slope: vec2f,   // slope of the procedural detail
}

fn terrainVertex(vi: u32, ii: u32) -> TerrainVertex {
  let camera = nodes[0].xyz;
  let node = nodes[1u + ii];
  let cell = vec2f(f32(vi % (PATCH_U + 1u)), f32(vi / (PATCH_U + 1u)));
  let p0 = node.xy + cell / PATCH * node.z;
  let w0 = vec3f(terrain.origin.x + p0.x, terrain.origin.y + baseHeight(p0), terrain.origin.z + p0.y);
  // A patch of this level exists up to twice the distance at which its
  // children merge into it: morph over the last 30 % of that range.
  let morphEnd = 2.0 * terrain.field.w * node.z;
  let morphStart = 0.7 * morphEnd;
  let k = select(clamp((distance(camera, w0) - morphStart) / (morphEnd - morphStart), 0.0, 1.0), 0.0, node.w >= 98.5);
  let snapped = cell - (cell - 2.0 * floor(cell * 0.5)) * k;
  let local = node.xy + snapped / PATCH * node.z;
  let spacing = node.z / PATCH * (1.0 + k);
  var o: TerrainVertex;
  o.local = local;
  let d = detailHeight(local, spacing);
  o.world = vec3f(terrain.origin.x + local.x, terrain.origin.y + baseHeight(local) + d, terrain.origin.z + local.y);
  let e = max(spacing * 0.5, 0.25);
  o.slope = vec2f(
    detailHeight(local + vec2f(e, 0.0), spacing) - detailHeight(local - vec2f(e, 0.0), spacing),
    detailHeight(local + vec2f(0.0, e), spacing) - detailHeight(local - vec2f(0.0, e), spacing),
  ) / (2.0 * e);
  return o;
}
`;

/** Fragment-side surface of the terrain. */
export const terrainSurfaceWgsl = /* wgsl */ `
struct TerrainSurface {
  albedo: vec3f,
  normal: vec3f,
  ng: vec3f,
  roughness: f32,
  metallic: f32,
  occlusion: f32,
}

fn terrainSurface(world: vec3f, detailSlope: vec2f) -> TerrainSurface {
  let local = world.xz - terrain.origin.xz;
  let size = terrain.field.x;
  let cells = terrain.field.y;
  let cs = size / cells;
  let texel = clamp((local / size + 0.5) * cells, vec2f(0.0), vec2f(cells)) + 0.5;
  let slope = textureSample(slopeTexture, mapSampler, texel / (cells + 1.0)).rg * (terrain.field.z / cs);
  let ng = normalize(vec3f(-(slope.x + detailSlope.x), 1.0, -(slope.y + detailSlope.y)));

  let count = u32(terrain.layers.x);
  let splatUv = local / size + 0.5;
  var weights: array<f32, ${MAX_TERRAIN_LAYERS}>;
  for (var i = 0u; i < ${MAX_TERRAIN_LAYERS}u; i++) { weights[i] = 0.0; }
  let first = textureSample(splatTexture, mapSampler, splatUv, 0);
  weights[0] = first.r; weights[1] = first.g; weights[2] = first.b; weights[3] = first.a;
  if (terrain.layers.z > 1.5) {
    let second = textureSample(splatTexture, mapSampler, splatUv, 1);
    weights[4] = second.r; weights[5] = second.g; weights[6] = second.b; weights[7] = second.a;
  }
  var total = 0.0;
  for (var i = 0u; i < ${MAX_TERRAIN_LAYERS}u; i++) {
    if (i >= count) { weights[i] = 0.0; }
    total += weights[i];
  }
  if (total < 0.004) { weights[0] = 1.0; total = 1.0; }
  for (var i = 0u; i < ${MAX_TERRAIN_LAYERS}u; i++) { weights[i] = weights[i] / total; }

  let ddx = dpdx(local);
  let ddy = dpdy(local);
  var colors: array<vec3f, ${MAX_TERRAIN_LAYERS}>;
  var normals: array<vec3f, ${MAX_TERRAIN_LAYERS}>;
  var data: array<vec3f, ${MAX_TERRAIN_LAYERS}>;
  var heights: array<f32, ${MAX_TERRAIN_LAYERS}>;
  var strongest = 0.0;
  let blend = terrain.layers.y;
  for (var i = 0u; i < ${MAX_TERRAIN_LAYERS}u; i++) {
    heights[i] = 0.5;
    colors[i] = vec3f(0.0);
    normals[i] = vec3f(0.0, 0.0, 1.0);
    data[i] = vec3f(1.0, 0.8, 0.0);
    if (weights[i] > 0.004) {
      let tint = terrain.layer[i];
      let uv = local * tint.w;
      let g1 = ddx * tint.w;
      let g2 = ddy * tint.w;
      let a = textureSampleGrad(albedoLayers, layerSampler, uv, i32(i), g1, g2);
      let n = textureSampleGrad(dataLayers, layerSampler, uv, i32(2u * i), g1, g2);
      let o = textureSampleGrad(dataLayers, layerSampler, uv, i32(2u * i + 1u), g1, g2);
      colors[i] = a.rgb * tint.rgb;
      normals[i] = n.xyz * 2.0 - 1.0;
      data[i] = o.rgb;
      heights[i] = n.a;
    }
    strongest = max(strongest, weights[i] + blend * heights[i] * select(0.0, 1.0, weights[i] > 0.004));
  }
  // Height-based blending: the layer that is higher at a texel wins the
  // transition instead of fading linearly.
  var sum = 0.0;
  var sharp: array<f32, ${MAX_TERRAIN_LAYERS}>;
  for (var i = 0u; i < ${MAX_TERRAIN_LAYERS}u; i++) {
    sharp[i] = select(0.0, max(weights[i] + blend * heights[i] - strongest + 0.2, 0.0), weights[i] > 0.004);
    sum += sharp[i];
  }
  var albedo = vec3f(0.0);
  var tn = vec3f(0.0);
  var orm = vec3f(0.0);
  let mixing = clamp(blend * 2.0, 0.0, 1.0);
  for (var i = 0u; i < ${MAX_TERRAIN_LAYERS}u; i++) {
    let b = mix(weights[i], sharp[i] / max(sum, 1e-4), mixing);
    albedo += b * colors[i];
    tn += b * normals[i];
    orm += b * data[i];
  }
  if (count == 0u) { albedo = vec3f(0.32, 0.4, 0.2); orm = vec3f(1.0, 0.85, 0.0); }
  tn = normalize(vec3f(tn.xy, max(tn.z, 0.05)));
  // Tangent frame of the planar mapping: u along +x, v along +z (image up is -z).
  let t = normalize(vec3f(1.0, 0.0, 0.0) - ng * ng.x);
  let bt = cross(ng, t);
  var s: TerrainSurface;
  s.albedo = albedo;
  s.normal = normalize(t * tn.x + bt * tn.y + ng * tn.z);
  s.ng = ng;
  s.occlusion = clamp(orm.r, 0.0, 1.0);
  s.roughness = clamp(orm.g, 0.045, 1.0);
  s.metallic = clamp(orm.b, 0.0, 1.0);
  return s;
}
`;

const scenePrelude = /* wgsl */ `
${common}
${hdrWgsl}
${shadowsWgsl}
${aoWgsl}
${environmentWgsl}
${lightmapWgsl}
${probeWgsl}
${lightingWgsl}
`;

/** Lit, pick, ambient-occlusion and reflection-surface passes. */
export const terrainShader = /* wgsl */ `
${scenePrelude}
${terrainGeometryWgsl}
${terrainSurfaceWgsl}

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) slope: vec2f,
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let v = terrainVertex(vi, ii);
  var o: VOut;
  o.clip = frame.viewProj * vec4f(v.world, 1.0);
  o.world = v.world;
  o.slope = v.slope;
  return o;
}

fn viewOf(world: vec3f) -> vec3f {
  return select(normalize(frame.cameraPos.xyz - world), -frame.cameraDir.xyz, frame.cameraPos.w > 0.5);
}

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let t = terrainSurface(v.world, v.slope);
  if (frame.params.x > 0.5) { return hdrOut(t.albedo); }
  let view = viewOf(v.world);
  var s: Surface;
  s.world = v.world;
  s.normal = t.normal;
  s.ng = t.ng;
  s.view = view;
  s.nv = max(dot(t.normal, view), 1e-3);
  s.albedo = t.albedo;
  s.metallic = t.metallic;
  s.roughness = t.roughness;
  s.occlusion = t.occlusion;
  s.emissive = vec3f(0.0);
  s.indirect = vec3f(0.0);
  s.frag = v.clip.xy;
  var color = shadeSurface(s);
  color = applyFog(color, v.world, normalize(v.world - frame.cameraPos.xyz));
  return hdrOut(color);
}

struct PickOut {
  @location(0) id: vec2u,
  @location(1) normal: vec4f,
  @location(2) depth: f32,
}
@fragment fn fsPick(v: VOut) -> PickOut {
  let ng = terrainSurface(v.world, v.slope).ng;
  var o: PickOut;
  o.id = vec2u(bitcast<u32>(terrain.origin.w), 0u);
  o.normal = vec4f(ng * 0.5 + 0.5, 1.0);
  o.depth = v.clip.z;
  return o;
}

@fragment fn fsAo(v: VOut) -> @location(0) vec4f {
  let ng = terrainSurface(v.world, v.slope).ng;
  return vec4f(ng, dot(v.world - frame.cameraPos.xyz, frame.cameraDir.xyz));
}

struct ReflectionOut {
  @location(0) geometry: vec4f,
  @location(1) material: vec4f,
  @location(2) fallback: vec4f,
}
@fragment fn fsReflection(v: VOut) -> ReflectionOut {
  let t = terrainSurface(v.world, v.slope);
  let view = viewOf(v.world);
  let n = t.normal;
  let nv = max(dot(n, view), 1e-3);
  let reflectivity = environmentBrdf(mix(vec3f(0.04), t.albedo, t.metallic), t.roughness, nv);
  let ao = pow(max(ambientOcclusion(v.clip.xy, v.world), 1e-3), frame.envInfo.y);
  let r = reflect(-view, n);
  let weight = reflectivity * (specularOcclusion(nv, ao, t.roughness) * t.occlusion * horizonOcclusion(r, t.ng));
  let fallback = sceneReflection(v.world, r, t.roughness, ambientSpecular(r, t.roughness, nv));
  return ReflectionOut(vec4f(n, -(frame.view * vec4f(v.world, 1.0)).z),
    vec4f(weight, t.roughness), vec4f(fallback * weight, 0.0));
}
`;

/** Depth-only pass of the shadow maps. Group 0: the pass's matrix. */
export const terrainShadowShader = /* wgsl */ `
struct ShadowPass { viewProj: mat4x4f }
@group(0) @binding(0) var<uniform> shadowPass: ShadowPass;
${terrainGeometryWgsl}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  return shadowPass.viewProj * vec4f(terrainVertex(vi, ii).world, 1.0);
}
@fragment fn fs() {}
`;

/** Motion vectors: the terrain does not move, only the camera does. */
export const terrainMotionShader = /* wgsl */ `
${common}
${terrainGeometryWgsl}
struct MotionCamera { current: mat4x4f, previous: mat4x4f, previousView: mat4x4f }
@group(3) @binding(0) var<uniform> motionCamera: MotionCamera;
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) current: vec4f,
  @location(1) previous: vec4f,
  @location(2) depths: vec2f,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  let world = vec4f(terrainVertex(vi, ii).world, 1.0);
  var o: Out;
  o.clip = frame.viewProj * world;
  o.current = motionCamera.current * world;
  o.previous = motionCamera.previous * world;
  o.depths = vec2f(-(motionCamera.previousView * world).z, -(frame.view * world).z);
  return o;
}
@fragment fn fs(v: Out) -> @location(0) vec4f {
  let a = v.current.xy / v.current.w;
  let b = v.previous.xy / max(v.previous.w, 1e-6);
  let valid = v.previous.w > 0.0;
  return vec4f((a - b) * vec2f(0.5, -0.5), select(-1.0, v.depths.x, valid), v.depths.y);
}
`;
