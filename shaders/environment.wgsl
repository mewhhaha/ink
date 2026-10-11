struct Settings { roughness: f32, samples: u32, diffuse: u32, unused: u32 };
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var output: texture_storage_2d_array<rgba16float, write>;
fn direction(face: u32, uv: vec2f) -> vec3f {
  let p = uv * 2.0 - 1.0;
  switch face {
    case 0u: { return normalize(vec3f(1.0, -p.y, -p.x)); }
    case 1u: { return normalize(vec3f(-1.0, -p.y, p.x)); }
    case 2u: { return normalize(vec3f(p.x, 1.0, p.y)); }
    case 3u: { return normalize(vec3f(p.x, -1.0, -p.y)); }
    case 4u: { return normalize(vec3f(p.x, -p.y, 1.0)); }
    default: { return normalize(vec3f(-p.x, -p.y, -1.0)); }
  }
}
fn radiance(direction: vec3f) -> vec3f {
  let uv = vec2f(atan2(direction.z, direction.x) / 6.283185307 + 0.5, acos(clamp(direction.y, -1.0, 1.0)) / 3.141592654);
  return textureSampleLevel(source, linearSampler, uv, 0.0).rgb;
}
@compute @workgroup_size(8, 8) fn prefilter(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(output);
  if any(id.xy >= size) || id.z >= 6u { return; }
  let n = direction(id.z, (vec2f(id.xy) + 0.5) / vec2f(size));
  if settings.roughness <= 0.0001 && settings.diffuse == 0u {
    textureStore(output, vec2i(id.xy), i32(id.z), vec4f(radiance(n), 1.0)); return;
  }
  var up = vec3f(0.0, 1.0, 0.0);
  if abs(n.y) > 0.99 { up = vec3f(1.0, 0.0, 0.0); }
  let tangent = normalize(cross(up, n));
  let bitangent = cross(n, tangent);
  var sum = vec3f(0.0);
  var weights = 0.0;
  let count = clamp(settings.samples, 1u, 4096u);
  let a2 = pow(settings.roughness, 4.0);
  for (var i = 0u; i < count; i++) {
    let xi = vec2f(f32(i) / f32(count), f32(reverseBits(i)) * 2.3283064365386963e-10);
    let phi = 6.283185307 * xi.x;
    var cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a2 - 1.0) * xi.y));
    if settings.diffuse != 0u { cosTheta = sqrt(1.0 - xi.y); }
    let sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
    let h = tangent * cos(phi) * sinTheta + bitangent * sin(phi) * sinTheta + n * cosTheta;
    var l = normalize(2.0 * dot(n, h) * h - n);
    var weight = max(dot(n, l), 0.0);
    if settings.diffuse != 0u { l = h; weight = 1.0; }
    sum += radiance(l) * weight;
    weights += weight;
  }
  var scale = 1.0;
  if settings.diffuse != 0u { scale = 3.141592654; }
  textureStore(output, vec2i(id.xy), i32(id.z), vec4f(clamp(sum * scale / max(weights, 0.0001), vec3f(0.0), vec3f(65504.0)), 1.0));
}
