struct Scene {
  view: mat4x4f,
  projection: mat4x4f,
};
struct Draw {
  model: mat4x4f,
  normal: mat4x4f,
  color: vec4f,
  settings: vec4f,
  parameters: vec4f,
  extra: array<vec4f, 32>,
  surface: array<vec4f, 5>,
};
@group(0) @binding(0) var<uniform> scene: Scene;
@group(1) @binding(0) var<uniform> draw: Draw;

@vertex fn vertex(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return scene.projection * scene.view * draw.model * vec4f(position, 1.0);
}

@fragment fn fragment() -> @location(0) vec4f {
  let boost = max(1.0, max(draw.surface[4].w, draw.parameters.x));
  return vec4f(draw.color.rgb * boost, draw.color.a);
}
