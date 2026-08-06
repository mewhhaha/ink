export const surface_shader_source = `
fn ink_srgb_to_linear(color: vec3f) -> vec3f {
  let low = color / 12.92;
  let high = pow((color + vec3f(0.055)) / 1.055, vec3f(2.4));
  return select(high, low, color <= vec3f(0.04045));
}

fn ink_linear_to_srgb(color: vec3f) -> vec3f {
  let low = color * 12.92;
  let high = 1.055 * pow(max(color, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, color <= vec3f(0.0031308));
}

fn ink_toon_lighting(
  normal: vec3f,
  light_direction: vec3f,
  light_color: vec3f,
  light_intensity: f32,
) -> vec3f {
  let diffuse = max(dot(normalize(normal), normalize(-light_direction)), 0.0);
  let stepped_diffuse = ceil(diffuse * 3.0) / 3.0;
  return vec3f(0.35)
    + light_color * stepped_diffuse * light_intensity * 0.55;
}
`;
