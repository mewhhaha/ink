/**
 * Environment hooks: what the world looks like and how it lights surfaces.
 * With the environment-light system bound (`frame.systems.z`), they read the
 * baked sky (systems/environment_light.ts); without it (unlit, wireframe, a
 * hemisphere `Overlays.ambient` override) they fall back to the hemisphere
 * colours in the frame.
 *
 *   skyRadiance(dir)            the visible sky along a world direction: the
 *                               baked environment cube plus sun disk and stars
 *   skyNeutral(dir)             the author's gradient (orthographic views)
 *   ambientDiffuse(n)           irradiance / pi from 9 SH coefficients, times
 *                               which albedo is multiplied (scaled by ambient)
 *   ambientSpecular(r, roughness, nv)   GGX-prefiltered radiance along r
 *   environmentBrdf(f0, roughness, nv)  split-sum scale and bias (lookup)
 *   horizonOcclusion(r, ng)     fades reflections that point into the surface
 *   applyFog(color, world, viewDir)     viewDir: camera to world, normalised
 *
 * All return unoccluded light: ambient occlusion is multiplied in lighting.ts.
 */
import { skyWgsl } from "./sky.ts";

export const environmentWgsl = /* wgsl */ `
${skyWgsl}

fn frameSky() -> SkyParams {
  var p: SkyParams;
  p.sunDir = frame.sunDir;
  p.sunColor = frame.sunColor;
  p.sunTrans = frame.sunTrans;
  p.zenith = frame.skyZenith;
  p.horizon = frame.skyHorizon;
  p.ground = frame.skyGround;
  p.info = vec4f(frame.envInfo.z, frame.envInfo.w, frame.skyInfo.z, 0.0);
  return p;
}

fn skyNeutral(dir: vec3f) -> vec3f {
  return skyGradient(dir, frameSky());
}

fn skyRadiance(dir: vec3f) -> vec3f {
  let p = frameSky();
  if (frame.systems.z > 0.5 && p.info.x < 0.5) {
    let px = length(fwidth(dir));
    let c = textureSampleLevel(environmentCube, linearSampler, dir, 0.0).rgb;
    return c + skySunDisk(dir, p, px) + skyStars(dir, p, px);
  }
  return skyGradient(dir, p);
}

fn ambientDiffuse(n: vec3f) -> vec3f {
  if (frame.systems.z < 0.5) {
    return mix(frame.ground.rgb, frame.sky.rgb, n.y * 0.5 + 0.5);
  }
  var e = frame.sh[0].rgb * 0.282095;
  e += frame.sh[1].rgb * (0.488603 * n.y);
  e += frame.sh[2].rgb * (0.488603 * n.z);
  e += frame.sh[3].rgb * (0.488603 * n.x);
  e += frame.sh[4].rgb * (1.092548 * n.x * n.y);
  e += frame.sh[5].rgb * (1.092548 * n.y * n.z);
  e += frame.sh[6].rgb * (0.315392 * (3.0 * n.z * n.z - 1.0));
  e += frame.sh[7].rgb * (1.092548 * n.x * n.z);
  e += frame.sh[8].rgb * (0.546274 * (n.x * n.x - n.y * n.y));
  return max(e, vec3f(0.0)) * frame.envInfo.x;
}

fn ambientSpecular(r: vec3f, roughness: f32, nv: f32) -> vec3f {
  if (frame.systems.z < 0.5) {
    let soft = roughness * 0.6;
    let k = smoothstep(-0.3 - soft, 0.4 + soft, r.y);
    return mix(frame.ground.rgb, frame.sky.rgb * 1.6, k);
  }
  let lod = roughness * (frame.skyInfo.x - 1.0);
  return textureSampleLevel(specularCube, linearSampler, r, lod).rgb * frame.envInfo.x;
}

// Split-sum environment BRDF: the lookup when the system is bound, Karis'
// analytic fit otherwise.
fn environmentBrdf(f0: vec3f, roughness: f32, nv: f32) -> vec3f {
  if (frame.systems.z > 0.5) {
    let ab = textureSampleLevel(brdfLut, linearSampler, vec2f(nv, roughness), 0.0).rg;
    return f0 * ab.x + ab.y;
  }
  let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
  let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
  let r = roughness * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
  let ab = vec2f(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

// A normal-mapped surface can reflect into itself: fade reflections that point
// below the geometric surface (ng, facing the viewer).
fn horizonOcclusion(r: vec3f, ng: vec3f) -> f32 {
  let h = clamp(1.0 + 1.3 * dot(r, ng), 0.0, 1.0);
  return h * h;
}

fn hgPhase(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-3), 1.5));
}

// Colour of the fog along a view ray: the author's, or, for a procedural sky
// whose fog colour has alpha 0, the sky itself (a blurred look at the
// environment cube towards the horizon), so distance fades into the sky.
fn fogColorAlong(viewDir: vec3f) -> vec3f {
  if (frame.fogParams.w < 0.5 || frame.systems.z < 0.5) { return frame.fog.rgb; }
  let d = normalize(vec3f(viewDir.x, max(viewDir.y, 0.14), viewDir.z));
  return textureSampleLevel(environmentCube, linearSampler, d, frame.skyInfo.y).rgb;
}

// Exponential height fog: density falls off as exp(-falloff * (y - height));
// the optical depth along the ray is integrated analytically. Fog scatters
// the sun forward: a glow around the sun direction, in the sun's own colour
// (orange at sunset, gone at night).
fn applyFog(color: vec3f, world: vec3f, viewDir: vec3f) -> vec3f {
  let density = frame.fog.w;
  if (density <= 0.0) { return color; }
  let origin = frame.cameraPos.xyz;
  let dist = length(world - origin);
  let falloff = max(frame.fogParams.y, 0.0);
  let h0 = origin.y - frame.fogParams.x;
  let k = falloff * viewDir.y;
  let base = density * exp(clamp(-falloff * h0, -40.0, 40.0));
  var depth = base * dist;
  if (abs(k) > 1e-5) {
    depth = base * (1.0 - exp(clamp(-k * dist, -40.0, 40.0))) / k;
  }
  let amount = clamp(1.0 - exp(-max(depth, 0.0)), 0.0, 1.0);
  let glow = frame.sunLight.rgb * (0.5 * hgPhase(dot(viewDir, frame.sunDir.xyz), 0.72));
  return mix(color, fogColorAlong(viewDir) + glow, amount);
}
`;
