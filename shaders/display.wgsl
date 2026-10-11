struct Settings { exposure: f32, bloom: f32, unused: vec2f };
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var bloom: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
override encodeSRGB = true;
struct Vertex { @builtin(position) clip: vec4f, @location(0) uv: vec2f };
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Vertex {
  let p = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  var out: Vertex;
  out.clip = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(p.x, 1.0 - p.y);
  return out;
}
fn srgb(x: vec3f) -> vec3f {
  return select(1.055 * pow(max(x, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}
fn tone(hdr: vec3f) -> vec3f {
  let x = clamp(hdr, vec3f(0.0), vec3f(65504.0));
  return clamp(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
@fragment fn fragment(vertex: Vertex) -> @location(0) vec4f {
  let hdr = (textureSampleLevel(source, linearSampler, vertex.uv, 0.0).rgb + textureSampleLevel(bloom, linearSampler, vertex.uv, 0.0).rgb * settings.bloom) * exp2(settings.exposure);
  var display = tone(hdr);
  if encodeSRGB { display = srgb(display); }
  return vec4f(display, 1.0);
}
