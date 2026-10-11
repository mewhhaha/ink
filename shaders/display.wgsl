struct Settings { exposure: f32 };
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
override encodeSRGB = true;
struct Vertex { @builtin(position) clip: vec4f, @location(0) uv: vec2f };
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Vertex {
  let p = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  var out: Vertex;
  out.clip = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(p.x, 1.0 - p.y);
  return out;
}
fn srgb(x: f32) -> f32 {
  if x <= 0.0031308 { return x * 12.92; }
  return 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}
fn tone(x: f32) -> f32 {
  if x > 1.0 {
    return clamp((2.51 + 0.03 / x) / (2.43 + 0.59 / x + 0.14 / x / x), 0.0, 1.0);
  }
  return clamp(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
@fragment fn fragment(vertex: Vertex) -> @location(0) vec4f {
  let hdr = clamp(textureSampleLevel(source, linearSampler, vertex.uv, 0.0).rgb,
    vec3f(0.0), vec3f(65504.0)) * exp2(clamp(settings.exposure, -16.0, 16.0));
  var display = vec3f(tone(hdr.r), tone(hdr.g), tone(hdr.b));
  if encodeSRGB { display = vec3f(srgb(display.r), srgb(display.g), srgb(display.b)); }
  return vec4f(display, 1.0);
}
