/**
 * Compute shaders of the image-based lighting bake (systems/environment_light.ts):
 *
 *   bake        sky -> environment cube, mip 0 (all six faces in one dispatch)
 *   downsample  one mip of the environment cube from the one above it
 *   prefilter   GGX-convolved specular cube, one roughness per mip, by filtered
 *               importance sampling: every sample reads the environment mip
 *               whose texel covers the sample's solid angle, which keeps small
 *               bright features from turning into fireflies
 *   sh          the environment's cosine-convolved L2 spherical harmonics
 *   brdf        split-sum scale and bias lookup (once per device)
 *
 * Cube faces follow WebGPU's layout: +X -X +Y -Y +Z -Z, texel y runs down.
 */
import { skyWgsl } from "./sky.ts";

const cubeWgsl = /* wgsl */ `
const PI: f32 = 3.14159265359;

// Direction of a cube texel; uv in [-1, 1], v downwards.
fn cubeDir(face: u32, uv: vec2f) -> vec3f {
  switch face {
    case 0u: { return normalize(vec3f(1.0, -uv.y, -uv.x)); }
    case 1u: { return normalize(vec3f(-1.0, -uv.y, uv.x)); }
    case 2u: { return normalize(vec3f(uv.x, 1.0, uv.y)); }
    case 3u: { return normalize(vec3f(uv.x, -1.0, -uv.y)); }
    case 4u: { return normalize(vec3f(uv.x, -uv.y, 1.0)); }
    default: { return normalize(vec3f(-uv.x, -uv.y, -1.0)); }
  }
}

fn texelUv(id: vec3u, size: u32) -> vec2f {
  return (vec2f(id.xy) + 0.5) / f32(size) * 2.0 - 1.0;
}
`;

export const bakeShader = /* wgsl */ `
${skyWgsl}
${cubeWgsl}
struct Bake {
  sky: SkyParams,
  size: vec4f,
}
@group(0) @binding(0) var<uniform> bake: Bake;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = u32(bake.size.x);
  if (id.x >= size || id.y >= size) { return; }
  let dir = cubeDir(id.z, texelUv(id, size));
  textureStore(dst, id.xy, id.z, vec4f(skyBake(dir, bake.sky), 1.0));
}
`;

export const downsampleShader = /* wgsl */ `
${cubeWgsl}
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst).x;
  if (id.x >= size || id.y >= size) { return; }
  let uv = (vec2f(id.xy) + 0.5) / f32(size);
  textureStore(dst, id.xy, id.z, vec4f(textureSampleLevel(src, smp, uv, i32(id.z), 0.0).rgb, 1.0));
}
`;

export const prefilterShader = /* wgsl */ `
${cubeWgsl}
struct Params {
  roughness: f32,
  samples: f32,
  envSize: f32,
  mips: f32,
}
@group(0) @binding(0) var env: texture_2d_array<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: Params;

// Cube sampling through array faces avoids SwiftShader's stale cube borders
// after compute writes. Interior samples use hardware bilinear filtering;
// edge taps are projected onto the adjacent face before trilinear blending.
fn cubeUv(d: vec3f) -> vec3f {
  let a = abs(d);
  var uv: vec2f;
  var face: f32;
  if (a.x >= a.y && a.x >= a.z) {
    uv = vec2f(select(d.z, -d.z, d.x > 0.0), -d.y) / a.x;
    face = select(1.0, 0.0, d.x > 0.0);
  } else if (a.y >= a.z) {
    uv = vec2f(d.x, select(-d.z, d.z, d.y > 0.0)) / a.y;
    face = select(3.0, 2.0, d.y > 0.0);
  } else {
    uv = vec2f(select(-d.x, d.x, d.z > 0.0), -d.y) / a.z;
    face = select(5.0, 4.0, d.z > 0.0);
  }
  return vec3f(uv * 0.5 + 0.5, face);
}

fn cubeTap(p: vec2i, face: i32, size: i32, mip: i32) -> vec3f {
  if (all(p >= vec2i(0)) && all(p < vec2i(size))) {
    return textureLoad(env, p, face, mip).rgb;
  }
  let d = cubeDir(u32(face), (vec2f(p) + 0.5) / f32(size) * 2.0 - 1.0);
  let c = cubeUv(d);
  let q = clamp(vec2i(c.xy * f32(size)), vec2i(0), vec2i(size - 1));
  return textureLoad(env, q, i32(c.z), mip).rgb;
}

fn cubeLevel(c: vec3f, mip: i32) -> vec3f {
  let size = i32(textureDimensions(env, mip).x);
  let p = c.xy * f32(size) - 0.5;
  let base = vec2i(floor(p));
  let face = i32(c.z);
  if (all(base >= vec2i(0)) && all(base + vec2i(1) < vec2i(size))) {
    return textureSampleLevel(env, smp, c.xy, face, f32(mip)).rgb;
  }
  let f = fract(p);
  return mix(
    mix(cubeTap(base, face, size, mip), cubeTap(base + vec2i(1, 0), face, size, mip), f.x),
    mix(cubeTap(base + vec2i(0, 1), face, size, mip), cubeTap(base + vec2i(1, 1), face, size, mip), f.x), f.y);
}

fn sampleCube(d: vec3f, lod: f32) -> vec3f {
  let c = cubeUv(d);
  let l = clamp(lod, 0.0, params.mips - 1.0);
  let mip = i32(floor(l));
  let a = cubeLevel(c, mip);
  if (fract(l) == 0.0) { return a; }
  return mix(a, cubeLevel(c, mip + 1), fract(l));
}

fn radicalInverse(i: u32) -> f32 {
  var b = i;
  b = (b << 16u) | (b >> 16u);
  b = ((b & 0x55555555u) << 1u) | ((b & 0xAAAAAAAAu) >> 1u);
  b = ((b & 0x33333333u) << 2u) | ((b & 0xCCCCCCCCu) >> 2u);
  b = ((b & 0x0F0F0F0Fu) << 4u) | ((b & 0xF0F0F0F0u) >> 4u);
  b = ((b & 0x00FF00FFu) << 8u) | ((b & 0xFF00FF00u) >> 8u);
  return f32(b) * 2.3283064365386963e-10;
}

fn distGGX(nh: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst).x;
  if (id.x >= size || id.y >= size) { return; }
  let n = cubeDir(id.z, texelUv(id, size));
  // Mip chain of the source: texel solid angle of its base level.
  let texelSolid = 4.0 * PI / (6.0 * params.envSize * params.envSize);
  var color = vec3f(0.0);
  if (params.roughness < 0.001) {
    // Mirror: the source filtered to this cube's resolution.
    let lod = max(log2(params.envSize / f32(size)), 0.0);
    color = sampleCube(n, lod);
  } else {
    let alpha = params.roughness * params.roughness;
    let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(n.z) < 0.999);
    let tx = normalize(cross(up, n));
    let ty = cross(n, tx);
    let count = u32(params.samples);
    var weight = 0.0;
    for (var i = 0u; i < count; i = i + 1u) {
      let xi = vec2f((f32(i) + 0.5) / f32(count), radicalInverse(i));
      // GGX half vector around n.
      let phi = 2.0 * PI * xi.y;
      let cosT = sqrt((1.0 - xi.x) / (1.0 + (alpha * alpha - 1.0) * xi.x));
      let sinT = sqrt(max(1.0 - cosT * cosT, 0.0));
      let h = tx * (sinT * cos(phi)) + ty * (sinT * sin(phi)) + n * cosT;
      let l = 2.0 * dot(n, h) * h - n;
      let nl = dot(n, l);
      if (nl > 0.0) {
        // pdf of l with v = n: D * nh / (4 * vh) = D / 4.
        let pdf = distGGX(cosT, alpha) * 0.25;
        let sampleSolid = 1.0 / (f32(count) * pdf + 1e-4);
        let lod = clamp(0.5 * log2(sampleSolid / texelSolid) + 1.0, 0.0, params.mips - 1.0);
        color += sampleCube(l, lod) * nl;
        weight += nl;
      }
    }
    color = color / max(weight, 1e-4);
  }
  textureStore(dst, id.xy, id.z, vec4f(color, 1.0));
}
`;

export const shShader = /* wgsl */ `
${cubeWgsl}
struct Params { lod: f32, size: f32, pad0: f32, pad1: f32 }
@group(0) @binding(0) var env: texture_2d_array<f32>;
@group(0) @binding(2) var<storage, read_write> out: array<vec4f, 9>;
@group(0) @binding(3) var<uniform> params: Params;

var<workgroup> scratch: array<f32, 256>;

fn basis(d: vec3f, i: u32) -> f32 {
  switch i {
    case 0u: { return 0.282095; }
    case 1u: { return 0.488603 * d.y; }
    case 2u: { return 0.488603 * d.z; }
    case 3u: { return 0.488603 * d.x; }
    case 4u: { return 1.092548 * d.x * d.y; }
    case 5u: { return 1.092548 * d.y * d.z; }
    case 6u: { return 0.315392 * (3.0 * d.z * d.z - 1.0); }
    case 7u: { return 1.092548 * d.x * d.z; }
    default: { return 0.546274 * (d.x * d.x - d.y * d.y); }
  }
}

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(local_invocation_index) li: u32) {
  let size = u32(params.size);
  let perFace = size * size;
  let total = perFace * 6u;
  let texel = 2.0 / params.size;
  var acc: array<vec3f, 9>;
  for (var k = li; k < total; k = k + 256u) {
    let face = k / perFace;
    let rem = k % perFace;
    let id = vec3u(rem % size, rem / size, face);
    let uv = texelUv(id, size);
    let dir = cubeDir(face, uv);
    let solid = texel * texel / pow(1.0 + dot(uv, uv), 1.5);
    let radiance = textureLoad(env, vec2i(id.xy), i32(face), 0).rgb * solid;
    for (var i = 0u; i < 9u; i = i + 1u) {
      acc[i] += radiance * basis(dir, i);
    }
  }
  for (var i = 0u; i < 9u; i = i + 1u) {
    // Cosine lobe convolution (pi, 2pi/3, pi/4), divided by pi so the shader
    // gets "irradiance / pi", the number albedo is multiplied by.
    var band = 1.0;
    if (i >= 1u && i < 4u) { band = 2.0 / 3.0; }
    if (i >= 4u) { band = 0.25; }
    var sum = vec3f(0.0);
    for (var c = 0u; c < 3u; c = c + 1u) {
      scratch[li] = acc[i][c];
      workgroupBarrier();
      for (var s = 128u; s > 0u; s = s >> 1u) {
        if (li < s) { scratch[li] += scratch[li + s]; }
        workgroupBarrier();
      }
      sum[c] = scratch[0];
      workgroupBarrier();
    }
    if (li == 0u) { out[i] = vec4f(sum * band, 0.0); }
  }
}
`;

export const brdfShader = /* wgsl */ `
${cubeWgsl}
@group(0) @binding(0) var dst: texture_storage_2d<rgba16float, write>;

fn radicalInverse(i: u32) -> f32 {
  var b = i;
  b = (b << 16u) | (b >> 16u);
  b = ((b & 0x55555555u) << 1u) | ((b & 0xAAAAAAAAu) >> 1u);
  b = ((b & 0x33333333u) << 2u) | ((b & 0xCCCCCCCCu) >> 2u);
  b = ((b & 0x0F0F0F0Fu) << 4u) | ((b & 0xF0F0F0F0u) >> 4u);
  b = ((b & 0x00FF00FFu) << 8u) | ((b & 0xFF00FF00u) >> 8u);
  return f32(b) * 2.3283064365386963e-10;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst).x;
  if (id.x >= size || id.y >= size) { return; }
  let nv = (f32(id.x) + 0.5) / f32(size);
  let roughness = (f32(id.y) + 0.5) / f32(size);
  let alpha = roughness * roughness;
  let v = vec3f(sqrt(1.0 - nv * nv), 0.0, nv);
  var a = 0.0;
  var b = 0.0;
  let count = 512u;
  for (var i = 0u; i < count; i = i + 1u) {
    let xi = vec2f((f32(i) + 0.5) / f32(count), radicalInverse(i));
    let phi = 2.0 * PI * xi.y;
    let cosT = sqrt((1.0 - xi.x) / (1.0 + (alpha * alpha - 1.0) * xi.x));
    let sinT = sqrt(max(1.0 - cosT * cosT, 0.0));
    let h = vec3f(sinT * cos(phi), sinT * sin(phi), cosT);
    let l = 2.0 * dot(v, h) * h - v;
    let nl = l.z;
    let nh = h.z;
    let vh = max(dot(v, h), 0.0);
    if (nl > 0.0) {
      // The lighting's height-correlated Smith visibility, as G = V * 4 nl nv.
      let vis = 0.5 / mix(2.0 * nl * nv, nl + nv, alpha);
      let g = vis * 4.0 * nl * nv;
      let gv = g * vh / max(nh * nv, 1e-4);
      let fc = pow(1.0 - vh, 5.0);
      a += (1.0 - fc) * gv;
      b += fc * gv;
    }
  }
  textureStore(dst, id.xy, vec4f(a / f32(count), b / f32(count), 0.0, 1.0));
}
`;
