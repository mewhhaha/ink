/** Auto exposure: the HDR image is reduced to its average log2 luminance in
 * 8x8 steps (rg32float: sum of logs, sample count), then an adaptation pass
 * moves the stored exposure multiplier towards 0.18 / average luminance. */
import { hdrWgsl } from "./hdr.ts";

export const exposureShader = /* wgsl */ `
${hdrWgsl}

@group(0) @binding(0) var src: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

const MIN_LOG: f32 = -10.0;
const MAX_LOG: f32 = 12.0;

// Level 0: scene luminance of 8x8 pixels of the decoded HDR image. Pixels the
// scene did not cover (flat background, alpha 0) do not count.
@fragment fn fsLuma(@builtin(position) frag: vec4f) -> @location(0) vec2f {
  let size = vec2i(textureDimensions(src));
  let base = vec2i(frag.xy) * 8;
  var sum = 0.0;
  var count = 0.0;
  for (var y = 0; y < 8; y = y + 1) {
    for (var x = 0; x < 8; x = x + 1) {
      let p = base + vec2i(x, y);
      if (p.x >= size.x || p.y >= size.y) { continue; }
      let t = textureLoad(src, p, 0);
      if (t.a < 0.5) { continue; }
      let l = dot(t.rgb / t.a, vec3f(0.2126, 0.7152, 0.0722));
      sum += clamp(log2(max(l, 1e-4)), MIN_LOG, MAX_LOG);
      count += 1.0;
    }
  }
  return vec2f(sum, count);
}

// Later levels: add up 8x8 blocks of the previous one.
@fragment fn fsReduce(@builtin(position) frag: vec4f) -> @location(0) vec2f {
  let size = vec2i(textureDimensions(src));
  let base = vec2i(frag.xy) * 8;
  var sum = vec2f(0.0);
  for (var y = 0; y < 8; y = y + 1) {
    for (var x = 0; x < 8; x = x + 1) {
      let p = base + vec2i(x, y);
      if (p.x >= size.x || p.y >= size.y) { continue; }
      sum += textureLoad(src, p, 0).rg;
    }
  }
  return sum;
}

struct Adapt {
  timing: vec4f,  // x dt (s), y speed when brightening, z speed when darkening, w reset (1: jump)
  limits: vec4f,  // x key (target mid grey), y min multiplier, z max multiplier
}
@group(0) @binding(1) var previous: texture_2d<f32>;
@group(0) @binding(2) var<uniform> adapt: Adapt;

@fragment fn fsAdapt(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let total = textureLoad(src, vec2i(0), 0).rg;
  let prev = textureLoad(previous, vec2i(0), 0).r;
  if (total.g < 1.0) { return vec4f(max(prev, 1.0), 0.0, 0.0, 1.0); }
  let luminance = exp2(total.r / total.g);
  let goal = clamp(adapt.limits.x / luminance, adapt.limits.y, adapt.limits.z);
  if (adapt.timing.w > 0.5 || prev <= 0.0) { return vec4f(goal, 0.0, 0.0, 1.0); }
  // Adapt in log space; the eye adapts to darkness more slowly than to light.
  let speed = select(adapt.timing.z, adapt.timing.y, goal < prev);
  let t = 1.0 - exp(-adapt.timing.x * speed);
  return vec4f(exp2(mix(log2(prev), log2(goal), t)), 0.0, 0.0, 1.0);
}
`;
