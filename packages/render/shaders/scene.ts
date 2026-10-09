/** Mesh shaders: lit/unlit forward shading into the HDR target, picking ids
 * and the selection mask. All share one vertex stage and the
 * instance storage buffer. Lighting lives in lighting.ts and its hooks. */
import { aoWgsl } from "./ao.ts";
import { common } from "./common.ts";
import { environmentWgsl } from "./environment.ts";
import { hdrWgsl } from "./hdr.ts";
import { instanceWgsl } from "./instance.ts";
import { lightingWgsl } from "./lighting.ts";
import { lightmapWgsl } from "./lightmaps.ts";
import { probeWgsl } from "./probes.ts";
import { shadowsWgsl } from "./shadows.ts";

export const sceneShader = /* wgsl */ `
${common}
${hdrWgsl}
${shadowsWgsl}
${aoWgsl}
${environmentWgsl}
${lightmapWgsl}
${probeWgsl}
${lightingWgsl}

@group(1) @binding(0) var materialSampler: sampler;
@group(1) @binding(1) var baseTexture: texture_2d<f32>;   // sRGB colour
@group(1) @binding(2) var normalTexture: texture_2d<f32>; // linear, tangent space, +Y up
@group(1) @binding(3) var ormTexture: texture_2d<f32>;    // linear: occlusion, roughness, metallic
@group(1) @binding(4) var occlusionTexture: texture_2d<f32>;
@group(1) @binding(5) var emissionTexture: texture_2d<f32>;
@group(1) @binding(6) var normalSampler: sampler;
@group(1) @binding(7) var ormSampler: sampler;
@group(1) @binding(8) var occlusionSampler: sampler;
@group(1) @binding(9) var emissionSampler: sampler;

${instanceWgsl}

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) color: vec4f,
  @location(4) face: u32,
  @location(5) joints: vec4u,
  @location(6) weights: vec4f,
  @location(7) uv1: vec2f,
  @location(8) joints1: vec4u,
  @location(9) weights1: vec4f,
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) inst: u32,
}

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) color: vec4f,
  @location(4) @interpolate(flat) inst: u32,
  @location(5) @interpolate(flat) face: u32,
  @location(6) uv1: vec2f,
}

@vertex fn vs(v: VIn) -> VOut {
  let inst = instances[v.inst];
  let world = inst.model * skinPosition(inst, v.pos + morphDelta(inst, v.vertex, 0u), v.joints, v.weights, v.joints1, v.weights1);
  var o: VOut;
  o.clip = frame.viewProj * world;
  o.world = world.xyz;
  o.normal = inst.normalm * skinNormal(inst, v.normal + morphDelta(inst, v.vertex, 3u), v.joints, v.weights, v.joints1, v.weights1);
  o.uv = v.uv * inst.params.yz;
  o.uv1 = v.uv1 * inst.params.yz;
  o.color = v.color;
  o.inst = v.inst;
  o.face = v.face;
  return o;
}

// Tangent frame from screen-space derivatives (no tangent attribute needed),
// applied to a tangent-space normal with green = +Y (glTF / OpenGL).
fn perturbNormal(
  n: vec3f, dpx: vec3f, dpy: vec3f, dux: vec2f, duy: vec2f,
  tangentNormal: vec3f, strength: f32,
) -> vec3f {
  let perp2 = cross(dpy, n);
  let perp1 = cross(n, dpx);
  let t = perp2 * dux.x + perp1 * duy.x;
  let b = perp2 * dux.y + perp1 * duy.y;
  let invMax = inverseSqrt(max(max(dot(t, t), dot(b, b)), 1e-20));
  var tn = tangentNormal * 2.0 - 1.0;
  tn = vec3f(tn.xy * strength, tn.z);
  // The construction assumes derivatives in a y-up window; WebGPU's y runs
  // down, which negates both t and b. Image rows run down with v, so the +Y
  // (up) bitangent is -b: the two signs cancel for y.
  return normalize(-t * invMax * tn.x + b * invMax * tn.y + n * tn.z);
}

fn shadeMesh(v: VOut, linear: bool) -> vec4f {
  let inst = instances[v.inst];
  // Everything that needs derivatives or implicit LOD runs before branching.
  let tex = textureSample(baseTexture, materialSampler, materialUv(inst, v.uv, v.uv1, 0u));
  let normalUv = materialUv(inst, v.uv, v.uv1, 1u);
  let nmap = textureSample(normalTexture, normalSampler, normalUv).rgb;
  let orm = textureSample(ormTexture, ormSampler, materialUv(inst, v.uv, v.uv1, 2u)).rgb;
  let occlusion = textureSample(occlusionTexture, occlusionSampler, materialUv(inst, v.uv, v.uv1, 3u)).r;
  let emission = textureSample(emissionTexture, emissionSampler, materialUv(inst, v.uv, v.uv1, 4u)).rgb;
  let dpx = dpdx(v.world);
  let dpy = dpdy(v.world);
  let dux = dpdx(normalUv);
  let duy = dpdy(normalUv);
  let base = inst.color * v.color * tex;
  clipAlpha(inst, base.a);
  if (frame.params.x > 0.5 || (inst.skin.w & 1u) != 0u) {
    if (linear) { return base; }
    return hdrOut(base.rgb);
  }
  var n = normalize(v.normal);
  let toEye = frame.cameraPos.xyz - v.world;
  var view = normalize(toEye);
  if (frame.cameraPos.w > 0.5) { view = -frame.cameraDir.xyz; }
  // Two-sided shading: flip the normal toward the viewer on back faces.
  if (dot(n, view) < 0.0) { n = -n; }
  let ng = n;
  n = perturbNormal(n, dpx, dpy, dux, duy, nmap, inst.params.w);

  var s: Surface;
  s.world = v.world;
  s.normal = n;
  s.ng = ng;
  s.view = view;
  s.nv = max(dot(n, view), 1e-3);
  s.albedo = base.rgb;
  s.metallic = clamp(inst.params.x * orm.b, 0.0, 1.0);
  s.roughness = clamp(inst.emissive.w * orm.g, 0.045, 1.0);
  s.occlusion = select(orm.r, mix(1.0, occlusion, inst.surface.x), (inst.skin.w & 2u) != 0u);
  s.emissive = inst.emissive.rgb * emission;
  s.indirect = brushIrradiance(v.world, inst.surface.y, v.face);
  s.frag = v.clip.xy;
  var color = shadeSurface(s);
  color = applyFog(color, v.world, normalize(v.world - frame.cameraPos.xyz));
  if (linear) { return vec4f(color, base.a); }
  return hdrOut(color);
}

@fragment fn fs(v: VOut) -> @location(0) vec4f { return shadeMesh(v, false); }
@fragment fn fsTransparent(v: VOut) -> @location(0) vec4f { return shadeMesh(v, true); }

struct ReflectionOut {
  @location(0) geometry: vec4f,
  @location(1) material: vec4f,
  @location(2) fallback: vec4f,
}
// Single-sample screen data for ray marching; it shares poses, cutouts and
// material sampling with the forward pass, including normal maps.
@fragment fn fsReflection(v: VOut) -> ReflectionOut {
  let inst = instances[v.inst];
  let base = inst.color * v.color * textureSample(baseTexture, materialSampler, materialUv(inst, v.uv, v.uv1, 0u));
  let normalUv = materialUv(inst, v.uv, v.uv1, 1u);
  let nmap = textureSample(normalTexture, normalSampler, normalUv).rgb;
  let orm = textureSample(ormTexture, ormSampler, materialUv(inst, v.uv, v.uv1, 2u)).rgb;
  let occlusion = textureSample(occlusionTexture, occlusionSampler, materialUv(inst, v.uv, v.uv1, 3u)).r;
  let dpX = dpdx(v.world); let dpY = dpdy(v.world);
  let duX = dpdx(normalUv); let duY = dpdy(normalUv);
  clipAlpha(inst, base.a);
  let view = select(normalize(frame.cameraPos.xyz - v.world), -frame.cameraDir.xyz, frame.cameraPos.w > 0.5);
  var ng = normalize(v.normal);
  if (dot(ng, view) < 0.0) { ng = -ng; }
  let n = perturbNormal(ng, dpX, dpY, duX, duY, nmap, inst.params.w);
  let roughness = clamp(inst.emissive.w * orm.g, 0.045, 1.0);
  let metallic = clamp(inst.params.x * orm.b, 0.0, 1.0);
  let nv = max(dot(n, view), 1e-3);
  let reflectivity = environmentBrdf(mix(vec3f(0.04), base.rgb, metallic), roughness, nv);
  let ao = pow(max(ambientOcclusion(v.clip.xy, v.world), 1e-3), frame.envInfo.y);
  let materialAo = select(orm.r, mix(1.0, occlusion, inst.surface.x), (inst.skin.w & 2u) != 0u);
  let r = reflect(-view, n);
  var weight = reflectivity * (specularOcclusion(nv, ao, roughness) * materialAo * horizonOcclusion(r, ng));
  if ((inst.skin.w & 1u) != 0u) { weight = vec3f(0.0); }
  let fallback = sceneReflection(v.world, r, roughness, ambientSpecular(r, roughness, nv));
  return ReflectionOut(vec4f(n, -(frame.view * vec4f(v.world, 1.0)).z),
    vec4f(weight, roughness), vec4f(fallback * weight, 0.0));
}

// Wireframe: flat tinted colour.
@fragment fn fsWire(v: VOut) -> @location(0) vec4f {
  let inst = instances[v.inst];
  return hdrOut(mix(inst.color.rgb * v.color.rgb, vec3f(1.0), 0.35));
}

// Picking: entity id, face + 1 (0 when not a brush face), normal and depth.
struct PickOut {
  @location(0) id: vec2u,
  @location(1) normal: vec4f,
  @location(2) depth: f32,
}
@fragment fn fsPick(v: VOut) -> PickOut {
  let inst = instances[v.inst];
  clipAlpha(inst, inst.color.a * v.color.a * textureSampleLevel(baseTexture, materialSampler, materialUv(inst, v.uv, v.uv1, 0u), 0.0).a);
  var o: PickOut;
  o.id = vec2u(inst.ids.x, v.face + 1u);
  var n = normalize(v.normal);
  o.normal = vec4f(n * 0.5 + 0.5, 1.0);
  o.depth = v.clip.z;
  return o;
}

// Selection mask: r selected, g hovered.
@fragment fn fsMask(v: VOut) -> @location(0) vec4f {
  let inst = instances[v.inst];
  clipAlpha(inst, inst.color.a * v.color.a * textureSampleLevel(baseTexture, materialSampler, materialUv(inst, v.uv, v.uv1, 0u), 0.0).a);
  let flags = inst.ids.y;
  if (flags == 0u) { discard; }
  return vec4f(f32(flags & 1u), f32((flags >> 1u) & 1u), 0.0, 1.0);
}

// Sky --------------------------------------------------------------------------

struct SkyOut { @builtin(position) clip: vec4f, @location(0) ndc: vec2f }

@vertex fn vsSky(@builtin(vertex_index) vi: u32) -> SkyOut {
  var o: SkyOut;
  o.clip = fullscreenPosition(vi);
  o.ndc = o.clip.xy;
  return o;
}

@fragment fn fsSky(v: SkyOut) -> @location(0) vec4f {
  let a = unproject(vec3f(v.ndc, 0.0));
  let b = unproject(vec3f(v.ndc, 1.0));
  var dir = normalize(b - a);
  if (frame.cameraPos.w > 0.5) {
    // Orthographic: no view direction, so the screen height spans the sky
    // from just below the horizon (bottom) to high up (top).
    dir = normalize(vec3f(0.0, mix(-0.08, 1.4, v.ndc.y * 0.5 + 0.5), -1.0));
    return hdrOut(skyNeutral(dir));
  }
  let c = skyRadiance(dir);
  return hdrOut(applyFog(c, frame.cameraPos.xyz + dir * frame.fogParams.z, dir));
}
`;
