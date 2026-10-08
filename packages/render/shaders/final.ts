/** Final pass: display-referred linear light to sRGB with blue-noise dither,
 * plus the selection outline drawn from the mask texture. */
import { blueNoiseWgsl } from "./noise.ts";

export const finalShader = /* wgsl */ `
struct Final {
  size: vec2f,        // device px
  radius: f32,        // outline radius in device px
  hasMask: f32,
  selection: vec4f,   // outline colour (linear), a strength
  hover: vec4f,
  overlay: vec4f,     // internal-pixel jitter xy, separate overlay present z
}
@group(0) @binding(0) var color: texture_2d<f32>;
@group(0) @binding(1) var mask: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: Final;
${blueNoiseWgsl(0, 3)}
@group(0) @binding(4) var overlay: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn encode(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn sampleImage(image: texture_2d<f32>, pixel: vec2f) -> vec4f {
  let size = vec2i(textureDimensions(image));
  let at = pixel - 0.5;
  let p = vec2i(floor(at)); let f = fract(at);
  let a = textureLoad(image, clamp(p, vec2i(0), size - 1), 0);
  let b = textureLoad(image, clamp(p + vec2i(1, 0), vec2i(0), size - 1), 0);
  let c = textureLoad(image, clamp(p + vec2i(0, 1), vec2i(0), size - 1), 0);
  let d = textureLoad(image, clamp(p + vec2i(1, 1), vec2i(0), size - 1), 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
fn maskAt(p: vec2i) -> vec2f {
  let size = vec2i(textureDimensions(mask));
  var at = p;
  if (any(size != vec2i(u.size)) || any(u.overlay.xy != vec2f(0.0))) {
    at = vec2i((vec2f(p) + 0.5) / u.size * vec2f(size) + u.overlay.xy);
  }
  return textureLoad(mask, clamp(at, vec2i(0), size - vec2i(1)), 0).rg;
}

@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  var c = textureLoad(color, p, 0).rgb;
  if (any(textureDimensions(color) != vec2u(u.size))) {
    c = sampleImage(color, frag.xy / u.size * vec2f(textureDimensions(color))).rgb;
  }
  if (u.overlay.z > 0.5) {
    let o = sampleImage(overlay, frag.xy / u.size * vec2f(textureDimensions(overlay)) + u.overlay.xy);
    c = c * (1.0 - o.a) + o.rgb;
  }
  if (u.hasMask > 0.5) {
    let own = maskAt(p);
    var around = vec2f(0.0);
    // Sample a disc of the given radius; the outline is the part of it that
    // lies outside the shape.
    let r = u.radius;
    for (var i = 0; i < 16; i = i + 1) {
      let a = f32(i) * 0.3926990817; // 2*pi/16
      let d = vec2f(cos(a), sin(a));
      around = max(around, maskAt(p + vec2i(round(d * r))));
      around = max(around, maskAt(p + vec2i(round(d * r * 0.5))));
    }
    let outlineSel = clamp(around.x - own.x, 0.0, 1.0) * u.selection.a;
    let outlineHov = clamp(around.y - own.y, 0.0, 1.0) * u.hover.a * (1.0 - own.x);
    c = mix(c, u.selection.rgb, own.x * 0.14);
    c = mix(c, u.hover.rgb, own.y * 0.18 * (1.0 - own.x));
    c = mix(c, u.hover.rgb, outlineHov);
    c = mix(c, u.selection.rgb, outlineSel);
  }
  var e = encode(c);
  // Blue-noise dither with a triangular distribution (one level of
  // amplitude) to hide 8-bit banding; static, so frames are reproducible.
  let r = blueNoise(frag.xy) * 2.0 - 1.0;
  let tri = sign(r) * (1.0 - sqrt(1.0 - abs(r)));
  e = e + vec3f(tri / 255.0);
  return vec4f(e, 1.0);
}
`;
