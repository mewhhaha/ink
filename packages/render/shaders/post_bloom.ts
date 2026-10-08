/** Physically based bloom: a 13-tap downsample chain (Jimenez, Call of Duty:
 * Advanced Warfare) and a tent-filter upsample that blends each level into the
 * one above with a constant factor, so the result is a weighted average of
 * all levels (energy preserving, no threshold). The first level weights its
 * taps by 1 / (1 + luma) (Karis) so single hot pixels do not flicker. */
export const bloomShader = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: VOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

fn tap(uv: vec2f, ts: vec2f, dx: f32, dy: f32) -> vec3f {
  return textureSampleLevel(src, smp, uv + vec2f(dx, dy) * ts, 0.0).rgb;
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn karis(c: vec3f) -> f32 { return 1.0 / (1.0 + luma(c)); }

@fragment fn fsDown(v: VOut) -> @location(0) vec4f {
  let ts = 1.0 / vec2f(textureDimensions(src));
  let a = tap(v.uv, ts, -2.0, -2.0); let b = tap(v.uv, ts, 0.0, -2.0); let c = tap(v.uv, ts, 2.0, -2.0);
  let d = tap(v.uv, ts, -2.0, 0.0);  let e = tap(v.uv, ts, 0.0, 0.0);  let f = tap(v.uv, ts, 2.0, 0.0);
  let g = tap(v.uv, ts, -2.0, 2.0);  let h = tap(v.uv, ts, 0.0, 2.0);  let i = tap(v.uv, ts, 2.0, 2.0);
  let j = tap(v.uv, ts, -1.0, -1.0); let k = tap(v.uv, ts, 1.0, -1.0);
  let l = tap(v.uv, ts, -1.0, 1.0);  let m = tap(v.uv, ts, 1.0, 1.0);
  let color = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  return vec4f(color, 1.0);
}

@fragment fn fsDownKaris(v: VOut) -> @location(0) vec4f {
  let ts = 1.0 / vec2f(textureDimensions(src));
  let a = tap(v.uv, ts, -2.0, -2.0); let b = tap(v.uv, ts, 0.0, -2.0); let c = tap(v.uv, ts, 2.0, -2.0);
  let d = tap(v.uv, ts, -2.0, 0.0);  let e = tap(v.uv, ts, 0.0, 0.0);  let f = tap(v.uv, ts, 2.0, 0.0);
  let g = tap(v.uv, ts, -2.0, 2.0);  let h = tap(v.uv, ts, 0.0, 2.0);  let i = tap(v.uv, ts, 2.0, 2.0);
  let j = tap(v.uv, ts, -1.0, -1.0); let k = tap(v.uv, ts, 1.0, -1.0);
  let l = tap(v.uv, ts, -1.0, 1.0);  let m = tap(v.uv, ts, 1.0, 1.0);
  let g0 = (a + b + d + e) * 0.25;
  let g1 = (b + c + e + f) * 0.25;
  let g2 = (d + e + g + h) * 0.25;
  let g3 = (e + f + h + i) * 0.25;
  let g4 = (j + k + l + m) * 0.25;
  let w0 = 0.125 * karis(g0); let w1 = 0.125 * karis(g1);
  let w2 = 0.125 * karis(g2); let w3 = 0.125 * karis(g3);
  let w4 = 0.5 * karis(g4);
  let color = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  return vec4f(color, 1.0);
}

// Tent filter over the smaller level, blended onto the larger one.
@fragment fn fsUp(v: VOut) -> @location(0) vec4f {
  let ts = 1.0 / vec2f(textureDimensions(src));
  let a = tap(v.uv, ts, -1.0, 1.0);  let b = tap(v.uv, ts, 0.0, 1.0);  let c = tap(v.uv, ts, 1.0, 1.0);
  let d = tap(v.uv, ts, -1.0, 0.0);  let e = tap(v.uv, ts, 0.0, 0.0);  let f = tap(v.uv, ts, 1.0, 0.0);
  let g = tap(v.uv, ts, -1.0, -1.0); let h = tap(v.uv, ts, 0.0, -1.0); let i = tap(v.uv, ts, 1.0, -1.0);
  let color = (e * 4.0 + (b + d + f + h) * 2.0 + (a + c + g + i)) / 16.0;
  return vec4f(color, 1.0);
}
`;
