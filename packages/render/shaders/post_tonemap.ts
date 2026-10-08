/**
 * The composite pass: bloom, exposure, grading, tonemapping, vignette and
 * grain on the HDR image, then the overlay layer on top, written as
 * display-referred linear light. Unlit and wireframe frames (post.flags.x)
 * skip all of it and show base colours as authored. Pixels the scene did not
 * cover (alpha < 1, flat background) take the background colour instead.
 */
import { hdrWgsl } from "./hdr.ts";
import { blueNoiseWgsl } from "./noise.ts";

export const tonemapShader = /* wgsl */ `
${hdrWgsl}

struct Post {
  size: vec2f,       // device px
  exposure: f32,     // linear multiplier from manual EV
  bloom: f32,        // mix of the bloom image
  grade: vec4f,      // x tonemap (0 aces, 1 agx, 2 neutral, 3 reinhard, 4 linear), y contrast, z saturation, w temperature
  look: vec4f,       // x vignette, y grain, z frame index, w auto exposure (1: multiply by the adapted value)
  flags: vec4f,      // x bypass (unlit / wireframe), y has bloom, z has overlay, w input still packed (decode)
  background: vec4f, // linear colour, w 1 when a flat background replaces uncovered pixels
  transparency: vec4f, // x translucent layer present
}
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var bloomImage: texture_2d<f32>;
@group(0) @binding(2) var overlay: texture_2d<f32>;
@group(0) @binding(3) var adaptedExposure: texture_2d<f32>;
@group(0) @binding(4) var<uniform> post: Post;
${blueNoiseWgsl(0, 5)}
@group(0) @binding(6) var linearSampler: sampler;
@group(0) @binding(7) var translucent: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn luminance(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// Tonemappers ------------------------------------------------------------------

// Narkowicz's fit of the ACES filmic curve (per channel).
fn tonemapAces(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

// AgX (Troy Sotos) with the base look: Rec.2020 inset, log encoding, a
// polynomial fit of the sigmoid, outset and display gamma.
fn agxContrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x
    + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
fn tonemapAgx(color: vec3f) -> vec3f {
  let toRec2020 = transpose(mat3x3f(
    vec3f(0.6274, 0.3293, 0.0433),
    vec3f(0.0691, 0.9195, 0.0114),
    vec3f(0.0164, 0.0880, 0.8956)));
  let fromRec2020 = transpose(mat3x3f(
    vec3f(1.6605, -0.5876, -0.0728),
    vec3f(-0.1246, 1.1329, -0.0083),
    vec3f(-0.0182, -0.1006, 1.1187)));
  let inset = transpose(mat3x3f(
    vec3f(0.842479062253094, 0.0784335999999992, 0.0792237451477643),
    vec3f(0.0423282422610123, 0.878468636469772, 0.0791661274605434),
    vec3f(0.0423756549057051, 0.0784336, 0.879142973793104)));
  let outset = transpose(mat3x3f(
    vec3f(1.19687900512017, -0.0980208811401368, -0.0990297440797205),
    vec3f(-0.0528968517574562, 1.15190312990417, -0.0989611768448433),
    vec3f(-0.0529716355144438, -0.0980434501171241, 1.15107367264116)));
  let minEv = -12.47393;
  let maxEv = 4.026069;
  var c = inset * (toRec2020 * max(color, vec3f(0.0)));
  c = log2(max(c, vec3f(1e-10)));
  c = clamp((c - minEv) / (maxEv - minEv), vec3f(0.0), vec3f(1.0));
  c = agxContrast(c);
  c = outset * c;
  c = pow(max(c, vec3f(0.0)), vec3f(2.2));
  return clamp(fromRec2020 * c, vec3f(0.0), vec3f(1.0));
}

// Khronos PBR Neutral: keeps base colours intact below the shoulder.
fn tonemapNeutral(input: vec3f) -> vec3f {
  let startCompression = 0.8 - 0.04;
  let desaturation = 0.15;
  var color = input;
  let x = min(color.r, min(color.g, color.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  color = color - offset;
  let peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) { return color; }
  let d = 1.0 - startCompression;
  let newPeak = 1.0 - d * d / (peak + d - startCompression);
  color = color * (newPeak / peak);
  let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3f(newPeak), g);
}

// Reinhard on luminance, so hue and saturation survive.
fn tonemapReinhard(c: vec3f) -> vec3f {
  let l = luminance(c);
  return clamp(c / (1.0 + l), vec3f(0.0), vec3f(1.0));
}

fn tonemap(c: vec3f, kind: f32) -> vec3f {
  if (kind < 0.5) { return tonemapAces(c); }
  if (kind < 1.5) { return tonemapAgx(c); }
  if (kind < 2.5) { return tonemapNeutral(c); }
  if (kind < 3.5) { return tonemapReinhard(c); }
  return clamp(c, vec3f(0.0), vec3f(1.0));
}

// Grading (scene-referred, before the tonemapper) -------------------------------

fn grade(input: vec3f) -> vec3f {
  var c = input;
  // White balance: warm raises red and lowers blue, keeping luminance.
  let t = post.grade.w;
  let balance = vec3f(1.0 + 0.3 * t, 1.0 + 0.04 * t, 1.0 - 0.3 * t);
  c = c * balance / luminance(balance);
  // Contrast around mid grey, in log space.
  if (post.grade.y != 1.0) {
    c = 0.18 * pow(max(c, vec3f(1e-6)) / 0.18, vec3f(post.grade.y));
  }
  let l = luminance(c);
  return max(mix(vec3f(l), c, post.grade.z), vec3f(0.0));
}

@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  let uv = frag.xy / post.size;
  var h = textureLoad(hdr, p, 0);
  var transparent = vec4f(0.0);
  if (post.transparency.x > 0.5) { transparent = textureLoad(translucent, p, 0); }
  let hasTransparency = any(transparent != vec4f(0.0));
  if (post.flags.w > 0.5) { h = overHdr(vec4f(unpackHdr(h.rgb), h.a), transparent); }
  let coverage = h.a;
  // The image is premultiplied by coverage at the edges of a flat background.
  var scene = h.rgb / max(coverage, 1e-4);
  // Translucent radiance is already integrated, including additive light with
  // zero opacity. Do not divide it by coverage or discard it on an empty sky.
  if (hasTransparency) { scene = h.rgb; }
  var color: vec3f;
  var halo = vec3f(0.0);
  if (post.flags.x > 0.5) {
    color = clamp(scene, vec3f(0.0), vec3f(1.0));
  } else {
    var exposure = post.exposure;
    if (post.look.w > 0.5) { exposure = exposure * textureLoad(adaptedExposure, vec2i(0), 0).r; }
    if (post.flags.y > 0.5) {
      let glow = textureSampleLevel(bloomImage, linearSampler, uv, 0.0).rgb;
      scene = mix(scene, glow, post.bloom);
      // Over a flat background (no scene behind), the glow is added on its own.
      halo = tonemap(grade(glow * post.bloom * exposure), post.grade.x);
    }
    color = tonemap(grade(scene * exposure), post.grade.x);
    // Vignette: a smooth darkening towards the corners.
    let q = (uv - 0.5) * 2.0;
    let vignette = 1.0 - post.look.x * smoothstep(0.5, 1.5, length(q));
    color = color * vignette;
    halo = halo * vignette;
    // Film grain: animated blue noise, strongest in the mid tones.
    if (post.look.y > 0.0) {
      let n = blueNoiseAnimated(frag.xy, post.look.z) * 2.0 - 1.0;
      let l = clamp(luminance(color), 0.0, 1.0);
      color = max(color + n * post.look.y * 0.08 * (4.0 * l * (1.0 - l) + 0.15), vec3f(0.0));
    }
  }
  if (post.background.w > 0.5) {
    let c = clamp(coverage, 0.0, 1.0);
    if (hasTransparency) { color += post.background.rgb * (1.0 - c); }
    else { color = mix(post.background.rgb, color, c) + halo * pow(1.0 - c, 3.0); }
  }
  if (post.flags.z > 0.5) {
    let o = textureLoad(overlay, p, 0);
    color = color * (1.0 - o.a) + o.rgb;
  }
  return vec4f(color, 1.0);
}
`;
