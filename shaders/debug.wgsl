struct Matrix { value: mat4x4f };
@group(0) @binding(0) var<uniform> camera: Matrix;
struct Vertex { @builtin(position) clip: vec4f, @location(0) color: vec4f };
@vertex fn vertex(@location(0) position: vec3f, @location(1) color: vec4f) -> Vertex {
  var out: Vertex;
  out.clip = camera.value * vec4f(position, 1.0);
  out.color = color;
  return out;
}
@fragment fn fragment(vertex: Vertex) -> @location(0) vec4f { return vertex.color; }
