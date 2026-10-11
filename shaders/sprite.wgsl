struct Matrix { value: mat4x4f };
@group(0) @binding(0) var<uniform> camera: Matrix;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
struct Vertex { @builtin(position) clip: vec4f, @location(0) uv: vec2f, @location(1) color: vec4f };
@vertex fn vertex(@location(0) position: vec3f, @location(1) uv: vec2f, @location(2) color: vec4f) -> Vertex {
  var out: Vertex;
  out.clip = camera.value * vec4f(position, 1.0);
  out.uv = uv;
  out.color = color;
  return out;
}
@fragment fn fragment(vertex: Vertex) -> @location(0) vec4f {
  let color = textureSample(atlas, linearSampler, vertex.uv) * vertex.color;
  if color.a < 0.001 { discard; }
  return vec4f(clamp(color.rgb, vec3f(0.0), vec3f(65504.0)), color.a);
}
