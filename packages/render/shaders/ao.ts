/**
 * Ambient occlusion.
 *
 * Hook (in the scene shader): `ambientOcclusion(frag, world)` is how open the
 * surface is (1 = unoccluded), upsampled depth-aware from the half-resolution
 * buffer the AO system binds at 5 (r: visibility, g: view depth). The light
 * loop applies the environment's strength, multi-bounce for diffuse and
 * specular occlusion for reflections (functions below).
 *
 * Passes (half resolution, see systems/ao.ts):
 *   prepass   world normal + view depth of the plan's geometry (rgba32float)
 *   gtao      ground-truth AO (Jimenez et al.): horizon search along slices
 *             rotated by blue noise, cosine-weighted arc integral
 *   blurH/V   separable bilateral blur weighted by plane distance and normal
 */
import { common } from "./common.ts";
import { instanceWgsl } from "./instance.ts";
import { blueNoiseWgsl } from "./noise.ts";

export const aoWgsl = /* wgsl */ `
fn ambientOcclusion(frag: vec2f, world: vec3f) -> f32 {
  if (frame.systems.y < 0.5) { return 1.0; }
  let dims = vec2i(textureDimensions(aoTexture));
  let p = frag * 0.5 - 0.5;
  let base = vec2i(floor(p));
  let f = p - floor(p);
  let z = dot(world - frame.cameraPos.xyz, frame.cameraDir.xyz);
  var sum = 0.0;
  var weights = 0.0;
  for (var j = 0; j < 2; j = j + 1) {
    for (var i = 0; i < 2; i = i + 1) {
      let t = clamp(base + vec2i(i, j), vec2i(0), dims - vec2i(1));
      let s = textureLoad(aoTexture, t, 0);
      let bilinear = select(1.0 - f.x, f.x, i == 1) * select(1.0 - f.y, f.y, j == 1);
      let w = bilinear / (0.02 + abs(s.g - z) / max(z, 0.1) * 12.0);
      sum += s.r * w;
      weights += w;
    }
  }
  return sum / weights;
}

// Jimenez et al.: light bounces between close surfaces brighten occlusion
// on bright albedos.
fn multiBounceAo(ao: f32, albedo: vec3f) -> vec3f {
  let a = 2.0404 * albedo - 0.3324;
  let b = -4.7951 * albedo + 0.6417;
  let c = 2.7552 * albedo + 0.6903;
  return max(vec3f(ao), ((ao * a + b) * ao + c) * ao);
}

// Lagarde: occlusion of reflections from the AO of the diffuse hemisphere.
fn specularOcclusion(nv: f32, ao: f32, roughness: f32) -> f32 {
  return clamp(pow(nv + ao, exp2(-16.0 * roughness - 1.0)) - 1.0 + ao, 0.0, 1.0);
}
`;

/** Normal + view depth prepass, shaded with the frame group as group 0. */
export const aoPrepassShader = /* wgsl */ `
${common}
${instanceWgsl}
@group(1) @binding(0) var materialSampler: sampler;
@group(1) @binding(1) var baseTexture: texture_2d<f32>;

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) alpha: f32,
  @location(4) @interpolate(flat) inst: u32,
}

@vertex fn vs(
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) color: vec4f,
  @builtin(instance_index) i: u32,
) -> VOut {
  let inst = instances[i];
  let world = inst.model * vec4f(pos, 1.0);
  var o: VOut;
  o.clip = frame.viewProj * world;
  o.world = world.xyz;
  o.normal = inst.normalm * normal;
  o.uv = uv * inst.params.yz;
  o.alpha = color.a * inst.color.a;
  o.inst = i;
  return o;
}

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  clipAlpha(instances[v.inst], v.alpha * textureSampleLevel(baseTexture, materialSampler, v.uv, 0.0).a);
  var n = normalize(v.normal);
  var view = normalize(frame.cameraPos.xyz - v.world);
  if (frame.cameraPos.w > 0.5) { view = -frame.cameraDir.xyz; }
  if (dot(n, view) < 0.0) { n = -n; }
  return vec4f(n, dot(v.world - frame.cameraPos.xyz, frame.cameraDir.xyz));
}
`;

export const AO_SLICES = 3;
export const AO_STEPS = 6;

/** GTAO and the blur. Group 0: params, gbuffer, blue noise, source image. */
export const aoShader = /* wgsl */ `
const PI: f32 = 3.14159265359;
const SLICES: i32 = ${AO_SLICES};
const STEPS: i32 = ${AO_STEPS};

struct AoParams {
  view: mat4x4f,
  proj: vec4f,    // m00, m11, ortho offset x, ortho offset y
  size: vec4f,    // half-resolution width, height
  info: vec4f,    // radius (m), orthographic, max radius (px), power
}
@group(0) @binding(0) var<uniform> ao: AoParams;
@group(0) @binding(1) var gbuffer: texture_2d<f32>;
${blueNoiseWgsl(0, 2)}
@group(0) @binding(3) var source: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

// View-space position (y up, looking down -z) of pixel centre px at depth z.
fn viewPos(px: vec2f, z: f32) -> vec3f {
  let ndc = vec2f(px.x / ao.size.x * 2.0 - 1.0, 1.0 - px.y / ao.size.y * 2.0);
  if (ao.info.y > 0.5) {
    return vec3f((ndc.x - ao.proj.z) / ao.proj.x, (ndc.y - ao.proj.w) / ao.proj.y, -z);
  }
  return vec3f(ndc.x * z / ao.proj.x, ndc.y * z / ao.proj.y, -z);
}

fn gbufferAt(p: vec2i) -> vec4f {
  let q = clamp(p, vec2i(0), vec2i(ao.size.xy) - vec2i(1));
  return textureLoad(gbuffer, q, 0);
}

@fragment fn fsAo(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let g = textureLoad(gbuffer, vec2i(frag.xy), 0);
  if (g.w <= 0.0) { return vec4f(1.0, 0.0, 0.0, 1.0); }
  let P = viewPos(frag.xy, g.w);
  let N = normalize((ao.view * vec4f(g.xyz, 0.0)).xyz);
  var V = normalize(-P);
  if (ao.info.y > 0.5) { V = vec3f(0.0, 0.0, 1.0); }
  let radius = ao.info.x;
  // Pixels per metre at this depth.
  var pxPerM = ao.proj.y * ao.size.y * 0.5;
  if (ao.info.y < 0.5) { pxPerM = pxPerM / g.w; }
  let rpx = min(radius * pxPerM, ao.info.z);
  if (rpx < 1.5) { return vec4f(1.0, g.w, 0.0, 1.0); }
  let falloffMul = -1.0 / (radius * 0.4);
  let falloffAdd = 2.5;

  let n1 = blueNoise(frag.xy);
  let n2 = blueNoise(frag.xy + vec2f(23.0, 41.0));
  var visibility = 0.0;
  for (var s = 0; s < SLICES; s = s + 1) {
    let phi = (f32(s) + n1) / f32(SLICES) * PI;
    let omega = vec2f(cos(phi), sin(phi));
    let dirVec = vec3f(omega, 0.0);
    let orthoDir = dirVec - dot(dirVec, V) * V;
    let axis = normalize(cross(orthoDir, V));
    let projN = N - axis * dot(N, axis);
    let projLen = length(projN);
    let signN = select(-1.0, 1.0, dot(orthoDir, projN) >= 0.0);
    let cosN = clamp(dot(projN, V) / max(projLen, 1e-4), 0.0, 1.0);
    let nAng = signN * acos(cosN);
    let lowCos0 = cos(nAng + PI * 0.5);
    let lowCos1 = cos(nAng - PI * 0.5);
    var hc0 = lowCos0;
    var hc1 = lowCos1;
    let screenDir = vec2f(omega.x, -omega.y);
    for (var k = 0; k < STEPS; k = k + 1) {
      var t = (f32(k) + n2) / f32(STEPS);
      t = t * t;
      let offset = screenDir * (1.0 + t * (rpx - 1.0));
      let c0 = floor(frag.xy + offset) + 0.5;
      let c1 = floor(frag.xy - offset) + 0.5;
      let g0 = gbufferAt(vec2i(c0));
      let g1 = gbufferAt(vec2i(c1));
      if (g0.w > 0.0) {
        let d = viewPos(c0, g0.w) - P;
        let len = length(d);
        let w = clamp(len * falloffMul + falloffAdd, 0.0, 1.0);
        hc0 = max(hc0, mix(lowCos0, dot(d / max(len, 1e-4), V) - 0.02, w));
      }
      if (g1.w > 0.0) {
        let d = viewPos(c1, g1.w) - P;
        let len = length(d);
        let w = clamp(len * falloffMul + falloffAdd, 0.0, 1.0);
        hc1 = max(hc1, mix(lowCos1, dot(d / max(len, 1e-4), V) - 0.02, w));
      }
    }
    let len = mix(projLen, 1.0, 0.05);
    var h0 = -acos(clamp(hc1, -1.0, 1.0));
    var h1 = acos(clamp(hc0, -1.0, 1.0));
    h0 = nAng + clamp(h0 - nAng, -PI * 0.5, PI * 0.5);
    h1 = nAng + clamp(h1 - nAng, -PI * 0.5, PI * 0.5);
    let sinN = sin(nAng);
    let arc0 = (cosN + 2.0 * h0 * sinN - cos(2.0 * h0 - nAng)) * 0.25;
    let arc1 = (cosN + 2.0 * h1 * sinN - cos(2.0 * h1 - nAng)) * 0.25;
    visibility += len * (arc0 + arc1);
  }
  visibility = clamp(visibility / f32(SLICES), 0.0, 1.0);
  return vec4f(pow(visibility, ao.info.w), g.w, 0.0, 1.0);
}

fn blur(frag: vec2f, dir: vec2i) -> vec4f {
  let p = vec2i(frag);
  let c = textureLoad(source, p, 0);
  if (c.g <= 0.0) { return c; }
  let g = textureLoad(gbuffer, p, 0);
  let P = viewPos(frag, g.w);
  let N = normalize((ao.view * vec4f(g.xyz, 0.0)).xyz);
  let tolerance = max(0.01 * g.w, 0.02);
  var sum = c.r;
  var weights = 1.0;
  for (var k = -4; k <= 4; k = k + 1) {
    if (k == 0) { continue; }
    let q = clamp(p + dir * k, vec2i(0), vec2i(ao.size.xy) - vec2i(1));
    let s = textureLoad(source, q, 0);
    if (s.g <= 0.0) { continue; }
    let gs = textureLoad(gbuffer, q, 0);
    let Ps = viewPos(vec2f(q) + 0.5, gs.w);
    let Ns = normalize((ao.view * vec4f(gs.xyz, 0.0)).xyz);
    let plane = abs(dot(N, Ps - P)) / tolerance;
    let spatial = exp(-f32(k * k) / 10.0);
    let w = spatial * exp(-plane * plane) * pow(max(dot(N, Ns), 0.0), 8.0);
    sum += s.r * w;
    weights += w;
  }
  return vec4f(sum / weights, c.g, 0.0, 1.0);
}

@fragment fn fsBlurH(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  return blur(frag.xy, vec2i(1, 0));
}
@fragment fn fsBlurV(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  return blur(frag.xy, vec2i(0, 1));
}
`;
