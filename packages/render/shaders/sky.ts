/**
 * The sky as pure functions of a direction and `SkyParams`, so the same code
 * runs in the environment bake (compute, shaders/ibl.ts) and in the scene
 * shader (shaders/environment.ts builds `SkyParams` from the frame uniform).
 *
 * Procedural sky: single-scattering atmosphere (Rayleigh + Mie + ozone,
 * constants in sky_model.ts) integrated per direction along the view ray with
 * a per-sample sun transmittance and planet shadow, which gives sunrise and
 * sunset colours, twilight after the sun has set, and a hazy horizon from
 * one model. A multiple-scattering term (isotropic, scaled by the sun's
 * transmittance) lifts the shadowed parts of the sky. Below the horizon the
 * sky continues as a lit ground colour. Night adds a dark blue floor and
 * hashed stars; the sun disk (limb darkened) and stars are drawn only in the
 * visible sky pass, never baked into the lighting cubes (the direct light
 * already carries the sun).
 *
 * `gradient` and `flat` skies use the author's colours.
 */
import {
  ATMOSPHERE_RADIUS,
  MIE_EXTINCTION,
  MIE_G,
  MIE_SCALE,
  MIE_SCATTERING,
  OBSERVER_ALTITUDE,
  OZONE,
  OZONE_CENTER,
  OZONE_WIDTH,
  PLANET_RADIUS,
  RAYLEIGH,
  RAYLEIGH_SCALE,
  SUN_ANGULAR_RADIUS,
} from "../sky_model.ts";

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const v3 = (v: readonly number[]) => `vec3f(${v.map(f).join(", ")})`;

export const skyWgsl = /* wgsl */ `
struct SkyParams {
  sunDir: vec4f,   // xyz towards the sun, w 1 when there is a sun
  sunColor: vec4f, // rgb sun radiance before the atmosphere (colour x intensity)
  sunTrans: vec4f, // rgb transmittance from the eye to the sun (0 below the horizon)
  zenith: vec4f,   // linear, intensity applied
  horizon: vec4f,
  ground: vec4f,
  info: vec4f,     // x kind (0 procedural, 1 gradient, 2 flat), y intensity, z view steps
}

const SKY_PLANET: f32 = ${f(PLANET_RADIUS)};
const SKY_TOP: f32 = ${f(ATMOSPHERE_RADIUS)};
const SKY_EYE: f32 = ${f(OBSERVER_ALTITUDE)};
const SKY_BETA_R = ${v3(RAYLEIGH)};
const SKY_BETA_O = ${v3(OZONE)};
const SKY_BETA_M: f32 = ${f(MIE_SCATTERING)};
const SKY_EXT_M: f32 = ${f(MIE_EXTINCTION)};
const SKY_SCALE_R: f32 = ${f(RAYLEIGH_SCALE)};
const SKY_SCALE_M: f32 = ${f(MIE_SCALE)};
const SKY_G: f32 = ${f(MIE_G)};
const SKY_OZONE_AT: f32 = ${f(OZONE_CENTER)};
const SKY_OZONE_W: f32 = ${f(OZONE_WIDTH)};
const SKY_SUN_RADIUS: f32 = ${f(SUN_ANGULAR_RADIUS)};
const SKY_NIGHT = vec3f(0.016, 0.026, 0.056);
const SKY_GAIN: f32 = 1.3;
const SKY_MS_GAIN: f32 = 0.9;

fn skyDensity(h: f32) -> vec3f {
  return vec3f(
    exp(-h / SKY_SCALE_R),
    exp(-h / SKY_SCALE_M),
    max(0.0, 1.0 - abs(h - SKY_OZONE_AT) / SKY_OZONE_W),
  );
}

fn skyExtinction(d: vec3f) -> vec3f {
  return SKY_BETA_R * d.x + vec3f(SKY_EXT_M * d.y) + SKY_BETA_O * d.z;
}

// Distance from p (inside the atmosphere) to its top along d.
fn skyExit(p: vec3f, d: vec3f) -> f32 {
  let b = dot(p, d);
  let c = dot(p, p) - SKY_TOP * SKY_TOP;
  return -b + sqrt(max(b * b - c, 0.0));
}

fn skyHitsPlanet(p: vec3f, d: vec3f) -> bool {
  let b = dot(p, d);
  let c = dot(p, p) - SKY_PLANET * SKY_PLANET;
  let disc = b * b - c;
  return disc > 0.0 && (-b - sqrt(disc)) > 0.0;
}

// Transmittance from p towards the sun (zero when the planet is in the way).
fn skySunVisible(p: vec3f, sunDir: vec3f) -> vec3f {
  if (skyHitsPlanet(p, sunDir)) { return vec3f(0.0); }
  let len = skyExit(p, sunDir);
  var tau = vec3f(0.0);
  for (var i = 0; i < 6; i = i + 1) {
    let x0 = f32(i) / 6.0;
    let x1 = f32(i + 1) / 6.0;
    let t0 = len * x0 * x0 * x0;
    let t1 = len * x1 * x1 * x1;
    let h = length(p + sunDir * (0.5 * (t0 + t1))) - SKY_PLANET;
    tau += skyExtinction(skyDensity(h)) * (t1 - t0);
  }
  return exp(-tau);
}

fn skyPhaseR(c: f32) -> f32 {
  return 3.0 / (16.0 * 3.14159265) * (1.0 + c * c);
}

// Cornette-Shanks phase function.
fn skyPhaseM(c: f32) -> f32 {
  let g = SKY_G;
  let k = 3.0 / (8.0 * 3.14159265) * (1.0 - g * g) / (2.0 + g * g);
  return k * (1.0 + c * c) / pow(1.0 + g * g - 2.0 * g * c, 1.5);
}

// In-scattered radiance per unit of sun radiance along a ray that stays above
// the horizon (dir.y >= 0).
fn skyScatter(dir: vec3f, sunDir: vec3f, steps: i32) -> vec3f {
  let origin = vec3f(0.0, SKY_PLANET + SKY_EYE, 0.0);
  let tmax = skyExit(origin, dir);
  let cosT = dot(dir, sunDir);
  let phR = skyPhaseR(cosT);
  let phM = skyPhaseM(cosT);
  var tau = vec3f(0.0);
  var light = vec3f(0.0);
  let n = f32(steps);
  for (var i = 0; i < steps; i = i + 1) {
    let x0 = f32(i) / n;
    let x1 = f32(i + 1) / n;
    let t0 = tmax * x0 * x0;
    let t1 = tmax * x1 * x1;
    let ds = t1 - t0;
    let p = origin + dir * (0.5 * (t0 + t1));
    let d = skyDensity(length(p) - SKY_PLANET);
    let ext = skyExtinction(d);
    let seg = exp(-ext * ds);
    let sunT = skySunVisible(p, sunDir);
    let rayleigh = SKY_BETA_R * d.x;
    let mie = SKY_BETA_M * d.y;
    let single = (rayleigh * phR + vec3f(mie * phM)) * sunT;
    // Multiple scattering, approximated as an isotropic source that follows
    // the light still reaching this height.
    let multi = (rayleigh + vec3f(mie)) * (SKY_MS_GAIN / (4.0 * 3.14159265)) * sqrt(sunT);
    let s = single + multi;
    light += exp(-tau) * (s - s * seg) / max(ext, vec3f(1e-9));
    tau += ext * ds;
  }
  return light;
}

fn skyHash(c: vec3f) -> f32 {
  var v = bitcast<vec3u>(vec3i(c)) * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v = v ^ (v >> vec3u(16u));
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return f32(v.x >> 8u) / 16777216.0;
}

fn skyGradient(dir: vec3f, p: SkyParams) -> vec3f {
  if (p.info.x > 1.5) { return p.zenith.rgb; }
  // The colours are tuned for what is seen after tonemapping, hence the scale.
  let up = smoothstep(0.0, 0.55, dir.y);
  var c = mix(p.horizon.rgb, p.zenith.rgb, up);
  c = mix(c, p.ground.rgb, smoothstep(0.0, -0.35, dir.y));
  return c * 0.6;
}

fn skyProcedural(dir: vec3f, p: SkyParams) -> vec3f {
  let sunE = p.sunColor.rgb * p.sunDir.w;
  let horiz = vec3f(dir.x, max(dir.y, 0.0), dir.z);
  let l = length(horiz);
  let dh = select(vec3f(0.0, 1.0, 0.0), horiz / max(l, 1e-6), l > 1e-4);
  var sky = skyScatter(dh, p.sunDir.xyz, i32(p.info.z)) * (sunE * SKY_GAIN);
  sky += SKY_NIGHT * mix(1.0, 0.55, dh.y);
  var c = sky;
  if (dir.y < 0.0) {
    // Ground lit by the sun and by the sky's own light, hazed towards the
    // horizon colour.
    let sunLit = sunE * p.sunTrans.rgb * max(p.sunDir.y, 0.0);
    let lit = mix(p.ground.rgb * (sunLit + sky * 0.8), sky, 0.25);
    c = mix(sky, lit, smoothstep(0.0, -0.08, dir.y));
  }
  return c * p.info.y;
}

// What the lighting cubes capture (no sun disk, no stars).
fn skyBake(dir: vec3f, p: SkyParams) -> vec3f {
  if (p.info.x < 0.5) { return skyProcedural(dir, p); }
  return skyGradient(dir, p);
}

fn skySunDisk(dir: vec3f, p: SkyParams, px: f32) -> vec3f {
  if (p.sunDir.w < 0.5 || dot(dir, p.sunDir.xyz) < 0.99) { return vec3f(0.0); }
  let ang = atan2(length(cross(dir, p.sunDir.xyz)), dot(dir, p.sunDir.xyz));
  let soft = max(px, 0.0006);
  let edge = 1.0 - smoothstep(SKY_SUN_RADIUS - soft, SKY_SUN_RADIUS + soft, ang);
  let mu = sqrt(max(1.0 - (ang * ang) / (SKY_SUN_RADIUS * SKY_SUN_RADIUS), 0.0));
  let limb = vec3f(1.0) - vec3f(0.45, 0.6, 0.85) * (1.0 - mu);
  return p.sunColor.rgb * p.sunTrans.rgb * limb * (edge * 2500.0 * p.info.y);
}

fn skyStars(dir: vec3f, p: SkyParams, px: f32) -> vec3f {
  let sunUp = p.sunDir.y * p.sunDir.w;
  let dark = 1.0 - smoothstep(-0.2, -0.04, sunUp);
  let above = smoothstep(0.0, 0.12, dir.y);
  if (dark * above <= 0.0) { return vec3f(0.0); }
  let scale = 110.0;
  let g = dir * scale;
  let cell = floor(g);
  let h = skyHash(cell);
  if (h < 0.9) { return vec3f(0.0); }
  let pos = vec3f(0.3) + 0.4 * vec3f(
    skyHash(cell + vec3f(17.0, 0.0, 0.0)),
    skyHash(cell + vec3f(0.0, 31.0, 0.0)),
    skyHash(cell + vec3f(0.0, 0.0, 47.0)),
  );
  let d = length(g - cell - pos) / scale;
  let size = mix(0.0007, 0.0018, h);
  let r = max(size, px * 0.9);
  let falloff = (1.0 - smoothstep(0.0, r, d));
  let mag = pow((h - 0.9) * 10.0, 3.0);
  let tint = mix(vec3f(1.0, 0.85, 0.7), vec3f(0.75, 0.85, 1.0), skyHash(cell + vec3f(5.0)));
  return tint * (falloff * falloff * (size / r) * (size / r) * (0.4 + 2.5 * mag) * dark * above * p.info.y);
}
`;
