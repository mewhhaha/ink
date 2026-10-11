struct Matrix { value: mat4x4f };
struct Object { model: mat4x4f };
@group(0) @binding(0) var<uniform> camera: Matrix;
@group(1) @binding(0) var<uniform> object: Object;
@vertex fn vertex(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return camera.value * object.model * vec4f(position, 1.0);
}
