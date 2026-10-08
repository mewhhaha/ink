/** Mesh shaders: lit/unlit forward shading into the HDR target, picking ids
 * and the selection mask. All share one vertex stage and the
 * instance storage buffer. Lighting lives in lighting.ts and its hooks. */
import { aoWgsl } from "./ao.ts";
import { common } from "./common.ts";
import { environmentWgsl } from "./environment.ts";
import { hdrWgsl } from "./hdr.ts";
import { instanceWgsl } from "./instance.ts";
import { lightingWgsl } from "./lighting.ts";
import { shadowsWgsl } from "./shadows.ts";

export const sceneShader = /* wgsl */ `
${common}
${hdrWgsl}
${shadowsWgsl}
${aoWgsl}
${environmentWgsl}
${lightingWgsl}

@group(1) @binding(0) var materialSampler: sampler;
@group(1) @binding(1) var baseTexture: texture_2d<f32>;   // sRGB colour
@group(1) @binding(2) var normalTexture: texture_2d<f32>; // linear, tangent space, +Y up
@group(1) @binding(3) var ormTexture: texture_2d<f32>;    // linear: occlusion, roughness, metallic

${instanceWgsl}

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) color: vec4f,
  @location(4) face: u32,
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
}

@vertex fn vs(v: VIn) -> VOut {
  let inst = instances[v.inst];
  let world = inst.model * vec4f(v.pos, 1.0);
  var o: VOut;
  o.clip = frame.viewProj * world;
  o.world = world.xyz;
  o.normal = inst.normalm * v.normal;
  o.uv = v.uv * inst.params.yz;
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

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let inst = instances[v.inst];
  // Everything that needs derivatives or implicit LOD runs before branching.
  let tex = textureSample(baseTexture, materialSampler, v.uv);
  let nmap = textureSample(normalTexture, materialSampler, v.uv).rgb;
  let orm = textureSample(ormTexture, materialSampler, v.uv).rgb;
  let dpx = dpdx(v.world);
  let dpy = dpdy(v.world);
  let dux = dpdx(v.uv);
  let duy = dpdy(v.uv);
  let base = inst.color * v.color * tex;
  if (frame.params.x > 0.5) {
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
  s.occlusion = orm.r;
  s.emissive = inst.emissive.rgb;
  s.frag = v.clip.xy;
  var color = shadeSurface(s);
  color = applyFog(color, v.world, normalize(v.world - frame.cameraPos.xyz));
  return hdrOut(color);
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
  var o: PickOut;
  o.id = vec2u(inst.ids.x, v.face + 1u);
  var n = normalize(v.normal);
  o.normal = vec4f(n * 0.5 + 0.5, 1.0);
  o.depth = v.clip.z;
  return o;
}

// Selection mask: r selected, g hovered.
@fragment fn fsMask(v: VOut) -> @location(0) vec4f {
  let flags = instances[v.inst].ids.y;
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
