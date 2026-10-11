struct Frame {
  viewProjection: mat4x4f,
  eye: vec4f,
  lightDirection: vec4f,
  lightRadiance: vec4f,
};
struct Object {
  model: mat4x4f,
  normalMatrix: mat4x4f,
  base: vec4f,
  material: vec4f,
  emission: vec4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> object: Object;
struct Vertex {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
};
@vertex fn vertex(@location(0) position: vec3f, @location(1) normal: vec3f) -> Vertex {
  let world = object.model * vec4f(position, 1.0);
  var out: Vertex;
  out.clip = frame.viewProjection * world;
  out.world = world.xyz;
  out.normal = (object.normalMatrix * vec4f(normal, 0.0)).xyz;
  return out;
}
fn unit(value: vec3f) -> vec3f {
  let scale = max(max(abs(value.x), abs(value.y)), abs(value.z));
  if scale == 0.0 { return vec3f(0.0); }
  return normalize(value / scale);
}
fn brdf(n: vec3f, v: vec3f, l: vec3f) -> vec3f {
  let nl = clamp(dot(n, l), 0.0, 1.0);
  let nv = max(dot(n, v), 0.00001);
  if nl <= 0.0 || dot(n, v) <= 0.0 { return vec3f(0.0); }
  let h = unit(v + l);
  let nh = clamp(dot(n, h), 0.0, 1.0);
  let vh = clamp(dot(v, h), 0.0, 1.0);
  let rough = clamp(object.material.y, 0.04, 1.0);
  let a2 = rough * rough * rough * rough;
  let denominator = (1.0 - nh * nh) + nh * nh * a2;
  let distribution = a2 / (3.14159265359 * denominator * denominator);
  let visibility = 0.5 / max(0.000001,
    nl * sqrt(nv * nv * (1.0 - a2) + a2) + nv * sqrt(nl * nl * (1.0 - a2) + a2));
  let metallic = clamp(object.material.x, 0.0, 1.0);
  let f0 = mix(vec3f(0.04), object.base.rgb, metallic);
  let fresnel = mix(f0, vec3f(1.0), pow(1.0 - vh, 5.0));
  let diffuse = object.base.rgb * (1.0 - fresnel) * (1.0 - metallic) / 3.14159265359;
  return (diffuse + fresnel * distribution * visibility) * nl;
}
@fragment fn fragment(vertex: Vertex) -> @location(0) vec4f {
  let n = unit(vertex.normal);
  let v = unit(frame.eye.xyz - vertex.world);
  let l = unit(-frame.lightDirection.xyz);
  let hdr = brdf(n, v, l) * frame.lightRadiance.rgb + object.emission.rgb;
  return vec4f(clamp(hdr, vec3f(0.0), vec3f(65504.0)), object.base.a);
}
