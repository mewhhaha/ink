// Right handed world, +Y up, -Z camera forward, WebGPU clip depth [0,1].
struct Frame {
  viewProjection: mat4x4f,
  previousViewProjection: mat4x4f,
  inverseViewProjection: mat4x4f,
  view: mat4x4f,
  eye: vec4f,
  sunDirection: vec4f,
  sunRadiance: vec4f,
  options: vec4f, // shadow bias, environment intensity, maximum specular mip, light count
  shadowMatrices: array<mat4x4f, 4>,
  splits: vec4f,
  previousView: mat4x4f,
};
struct Object {
  model: mat4x4f,
  previousModel: mat4x4f,
  normalMatrix: mat4x4f,
  base: vec4f,
  material: vec4f, // metallic, perceptual roughness, unused, unused
  emission: vec4f,
};
struct Light {
  positionRange: vec4f,
  radiance: vec4f,
  directionOuter: vec4f,
  innerType: vec4f, // inner cosine, 0 point / 1 spot
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadows: texture_depth_2d_array;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
@group(0) @binding(3) var specularEnvironment: texture_cube<f32>;
@group(0) @binding(4) var diffuseEnvironment: texture_cube<f32>;
@group(0) @binding(5) var environmentSampler: sampler;
@group(0) @binding(6) var<storage, read> lights: array<Light>;
@group(1) @binding(0) var<uniform> object: Object;
struct Vertex {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) currentClip: vec4f,
  @location(3) previousClip: vec4f,
  @location(4) previousDepth: f32,
};
override skyDepth = 1.0;
@vertex fn vertex(@location(0) position: vec3f, @location(1) normal: vec3f) -> Vertex {
  var out: Vertex;
  let world = object.model * vec4f(position, 1.0);
  out.world = world.xyz;
  out.normal = normalize((object.normalMatrix * vec4f(normal, 0.0)).xyz);
  out.clip = frame.viewProjection * world;
  out.currentClip = out.clip;
  out.previousClip = frame.previousViewProjection * object.previousModel * vec4f(position, 1.0);
  out.previousDepth = -(frame.previousView * object.previousModel * vec4f(position, 1.0)).z;
  return out;
}
fn brdf(base: vec3f, metal: f32, roughness: f32, n: vec3f, v: vec3f, l: vec3f) -> vec3f {
  let nl = max(dot(n, l), 0.0);
  let nv = max(dot(n, v), 0.00001);
  if nl <= 0.0 || dot(n, v) <= 0.0 { return vec3f(0.0); }
  let h = normalize(v + l);
  let nh = max(dot(n, h), 0.0);
  let vh = max(dot(v, h), 0.0);
  let rough = clamp(roughness, 0.04, 1.0);
  let a2 = pow(rough, 4.0);
  let denominator = nh * nh * (a2 - 1.0) + 1.0;
  let distribution = a2 / (3.141592654 * denominator * denominator);
  let visibility = 0.5 / max(0.000001, nl * sqrt(nv * nv * (1.0 - a2) + a2) + nv * sqrt(nl * nl * (1.0 - a2) + a2));
  let metallic = clamp(metal, 0.0, 1.0);
  let f0 = mix(vec3f(0.04), base, metallic);
  let fresnel = mix(f0, vec3f(1.0), pow(1.0 - vh, 5.0));
  let diffuse = base * (1.0 - fresnel) * (1.0 - metallic) / 3.141592654;
  return (diffuse + fresnel * distribution * visibility) * nl;
}
fn shadow(world: vec3f, normal: vec3f, depth: f32) -> f32 {
  var cascade = 3u;
  if depth < frame.splits.z { cascade = 2u; }
  if depth < frame.splits.y { cascade = 1u; }
  if depth < frame.splits.x { cascade = 0u; }
  let projected = frame.shadowMatrices[cascade] * vec4f(world + normal * frame.options.x, 1.0);
  let ndc = projected.xyz / projected.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || ndc.z < 0.0 || ndc.z > 1.0 { return 1.0; }
  let pixel = 1.0 / vec2f(textureDimensions(shadows));
  var visibility = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      visibility += textureSampleCompareLevel(shadows, shadowSampler, uv + vec2f(f32(x), f32(y)) * pixel, i32(cascade), ndc.z - frame.options.x * 0.1);
    }
  }
  return visibility / 9.0;
}
// Analytic split-sum DFG approximation, evaluated in linear radiance.
fn environmentBRDF(roughness: f32, nv: f32) -> vec2f {
  let r = roughness * vec4f(-1.0, -0.0275, -0.572, 0.022) + vec4f(1.0, 0.0425, 1.04, -0.04);
  let a = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
  return vec2f(-1.04, 1.04) * a + r.zw;
}
struct Surface {
  @location(0) direct: vec4f,
  @location(1) indirect: vec4f,
  @location(2) normalDepth: vec4f,
  @location(3) motion: vec4f,
};
@fragment fn fragment(vertex: Vertex) -> Surface {
  let n = normalize(vertex.normal);
  let v = normalize(frame.eye.xyz - vertex.world);
  let depth = -(frame.view * vec4f(vertex.world, 1.0)).z;
  var direct = object.emission.rgb;
  let sun = normalize(-frame.sunDirection.xyz);
  direct += brdf(object.base.rgb, object.material.x, object.material.y, n, v, sun) * frame.sunRadiance.rgb * shadow(vertex.world, n, depth);
  for (var i = 0u; i < min(u32(frame.options.w), arrayLength(&lights)); i++) {
    let light = lights[i];
    let delta = light.positionRange.xyz - vertex.world;
    let distance2 = max(dot(delta, delta), 0.0001);
    let l = delta * inverseSqrt(distance2);
    let range = max(light.positionRange.w, 0.0001);
    let fade = clamp(1.0 - distance2 * distance2 / pow(range, 4.0), 0.0, 1.0);
    var cone = 1.0;
    if light.innerType.y > 0.5 {
      cone = clamp((dot(normalize(light.directionOuter.xyz), -l) - light.directionOuter.w) / max(0.00001, light.innerType.x - light.directionOuter.w), 0.0, 1.0);
    }
    direct += brdf(object.base.rgb, object.material.x, object.material.y, n, v, l) * light.radiance.rgb * fade * fade * cone * cone / distance2;
  }
  let metallic = clamp(object.material.x, 0.0, 1.0);
  let rough = clamp(object.material.y, 0.04, 1.0);
  let f0 = mix(vec3f(0.04), object.base.rgb, metallic);
  let nv = max(dot(n, v), 0.0);
  let f = mix(f0, max(vec3f(1.0 - rough), f0), pow(1.0 - nv, 5.0));
  let diffuse = textureSampleLevel(diffuseEnvironment, environmentSampler, n, 0.0).rgb;
  let reflected = textureSampleLevel(specularEnvironment, environmentSampler, reflect(-v, n), rough * frame.options.z).rgb;
  let dfg = environmentBRDF(rough, nv);
  let indirect = (diffuse * object.base.rgb * (1.0 - metallic) * (1.0 - f) / 3.141592654 + reflected * (f0 * dfg.x + dfg.y)) * frame.options.y;
  let currentUV = vec2f(vertex.currentClip.x / vertex.currentClip.w * 0.5 + 0.5, 0.5 - vertex.currentClip.y / vertex.currentClip.w * 0.5);
  let previousUV = vec2f(vertex.previousClip.x / vertex.previousClip.w * 0.5 + 0.5, 0.5 - vertex.previousClip.y / vertex.previousClip.w * 0.5);
  var out: Surface;
  out.direct = vec4f(clamp(direct, vec3f(0.0), vec3f(65504.0)), 1.0);
  out.indirect = vec4f(clamp(indirect, vec3f(0.0), vec3f(65504.0)), 1.0);
  out.normalDepth = vec4f(normalize((frame.view * vec4f(n, 0.0)).xyz), depth);
  out.motion = vec4f(currentUV - previousUV, vertex.previousDepth, 0.0);
  return out;
}
@vertex fn skyVertex(@builtin(vertex_index) index: u32) -> Vertex {
  var out: Vertex;
  let p = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  out.clip = vec4f(p * 2.0 - 1.0, skyDepth, 1.0);
  out.world = (frame.inverseViewProjection * out.clip).xyz;
  out.normal = vec3f(0.0);
  out.currentClip = out.clip;
  out.previousClip = out.clip;
  out.previousDepth = 0.0;
  return out;
}
@fragment fn skyFragment(vertex: Vertex) -> Surface {
  // Fragment builtin position is pixel space; use interpolated clip instead.
  let point = frame.inverseViewProjection * vertex.currentClip;
  let direction = normalize(point.xyz / point.w - frame.eye.xyz);
  var out: Surface;
  out.direct = vec4f(textureSampleLevel(specularEnvironment, environmentSampler, direction, 0.0).rgb * frame.options.y, 1.0);
  out.indirect = vec4f(0.0);
  out.normalDepth = vec4f(0.0);
  var previous = frame.previousViewProjection * vec4f(direction, 0.0);
  if abs(previous.w) < 0.0001 { previous = frame.previousViewProjection * vec4f(point.xyz / point.w, 1.0); }
  out.motion = vec4f(vec2f(vertex.currentClip.x * 0.5 + 0.5, 0.5 - vertex.currentClip.y * 0.5) - vec2f(previous.x / previous.w * 0.5 + 0.5, 0.5 - previous.y / previous.w * 0.5), 0.0, 0.0);
  return out;
}
