import { LIGHTMAP_TEXELS, LIGHTMAP_TILE } from "../lightmap_geometry.ts";

export const chartStruct = /* wgsl */ `
struct Chart {
  origin: vec4f, u: vec4f, v: vec4f, normal: vec4f,
  polygon: vec4f, atlas: vec4f,
}
`;

export const lightmapWgsl = /* wgsl */ `
${chartStruct}
@group(0) @binding(15) var lightmap: texture_2d<f32>;
@group(0) @binding(16) var<storage, read> lightmapCharts: array<Chart>;
fn brushIrradiance(world: vec3f, first: f32, face: u32) -> vec3f {
  if (first < 1.0 || frame.gi.x <= 0.0 || face == 0xffffffffu) { return vec3f(0.0); }
  let c = lightmapCharts[u32(first) - 1u + face];
  let p = world - c.origin.xyz;
  let uv = clamp(vec2f(dot(p, c.u.xyz) / c.u.w, dot(p, c.v.xyz) / c.v.w), vec2f(0.0), vec2f(1.0));
  let texel = c.atlas.xy + 1.5 + uv * ${LIGHTMAP_TEXELS - 1}.0;
  return textureSampleLevel(lightmap, linearSampler, texel / vec2f(textureDimensions(lightmap)), 0.0).rgb * frame.gi.x;
}
`;

export const traceWgsl = /* wgsl */ `
struct Triangle { a: vec4f, ab: vec4f, ac: vec4f, albedo: vec4f, emission: vec4f }
struct Node { lo: vec3f, left: u32, hi: vec3f, right: u32 }
struct BakeLight { position: vec4f, color: vec4f, direction: vec4f }
@group(0) @binding(0) var<storage, read> triangles: array<Triangle>;
@group(0) @binding(1) var<storage, read> nodes: array<Node>;
@group(0) @binding(2) var<storage, read> lights: array<BakeLight>;
struct Hit { t: f32, triangle: u32 }
fn trace(origin: vec3f, direction: vec3f, maximum: f32) -> Hit {
  var hit = Hit(maximum, 0xffffffffu);
  let inverse = sign(direction + vec3f(1e-20)) / max(abs(direction), vec3f(1e-20));
  var stack: array<u32, 48>; stack[0] = 0u; var count = 1u;
  while (count > 0u) {
    count--; let node = nodes[stack[count]];
    let a = (node.lo - origin) * inverse; let b = (node.hi - origin) * inverse;
    let near = min(a, b); let far = max(a, b);
    if (max(max(near.x, near.y), max(near.z, 0.0)) > min(min(far.x, far.y), min(far.z, hit.t))) { continue; }
    if ((node.right & 0x80000000u) == 0u) {
      stack[count] = node.left; stack[count + 1u] = node.right; count += 2u;
      continue;
    }
    for (var i = 0u; i < (node.right & 0x7fffffffu); i++) {
      let index = node.left + i; let t = triangles[index];
      let p = cross(direction, t.ac.xyz); let determinant = dot(t.ab.xyz, p);
      if (abs(determinant) < 1e-8) { continue; }
      let s = origin - t.a.xyz; let u = dot(s, p) / determinant;
      let q = cross(s, t.ab.xyz); let v = dot(direction, q) / determinant;
      let distance = dot(t.ac.xyz, q) / determinant;
      if (u >= 0.0 && v >= 0.0 && u + v <= 1.0 && distance > 0.0005 && distance < hit.t) {
        hit = Hit(distance, index);
      }
    }
  }
  return hit;
}
fn random(state: ptr<function, u32>) -> f32 {
  *state = *state * 747796405u + 2891336453u;
  var word = ((*state >> ((*state >> 28u) + 4u)) ^ *state) * 277803737u;
  word = (word >> 22u) ^ word;
  return f32(word >> 8u) / 16777216.0;
}
fn hemisphere(normal: vec3f, state: ptr<function, u32>) -> vec3f {
  let r = sqrt(random(state)); let a = 6.28318530718 * random(state);
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(normal.y) < 0.9);
  let u = normalize(cross(up, normal)); let v = cross(normal, u);
  return u * (r * cos(a)) + v * (r * sin(a)) + normal * sqrt(1.0 - r * r);
}
fn directLight(point: vec3f, normal: vec3f, lightCount: u32) -> vec3f {
  var result = vec3f(0.0);
  for (var i = 0u; i < lightCount; i++) {
    let light = lights[i]; var l = -light.direction.xyz; var limit = 1e6; var attenuation = 1.0;
    if (light.position.w > 0.5) {
      let delta = light.position.xyz - point; limit = length(delta);
      if (limit >= light.color.w) { continue; }
      l = delta / max(limit, 1e-4);
      let window = pow(clamp(1.0 - pow(limit / light.color.w, 4.0), 0.0, 1.0), 2.0);
      attenuation = window / max(limit * limit, 0.01);
      if (light.position.w > 1.5) {
        attenuation *= smoothstep(light.direction.w, mix(light.direction.w, 1.0, 0.35), dot(-l, light.direction.xyz));
      }
    }
    let nl = max(dot(normal, l), 0.0);
    if (nl == 0.0 || attenuation == 0.0) { continue; }
    if (trace(point + normal * 0.002, l, limit - 0.004).triangle == 0xffffffffu) {
      result += light.color.rgb * (nl * attenuation);
    }
  }
  return result;
}
fn radiance(origin: vec3f, direction: vec3f, lightCount: u32, sky: vec3f, state: ptr<function, u32>) -> vec3f {
  var p = origin; var d = direction; var throughput = vec3f(1.0); var result = vec3f(0.0);
  for (var bounce = 0u; bounce < 2u; bounce++) {
    let hit = trace(p, d, 1e6);
    if (hit.triangle == 0xffffffffu) { result += throughput * sky; break; }
    let t = triangles[hit.triangle];
    p += d * hit.t;
    var n = normalize(cross(t.ab.xyz, t.ac.xyz));
    if (dot(n, d) > 0.0) { n = -n; }
    result += throughput * (t.emission.rgb + t.albedo.rgb * directLight(p, n, lightCount));
    throughput *= t.albedo.rgb;
    d = hemisphere(n, state); p += n * 0.002;
  }
  return result;
}
`;

export const lightmapBakeShader = /* wgsl */ `
${chartStruct}
${traceWgsl}
@group(0) @binding(3) var<storage, read> charts: array<Chart>;
@group(0) @binding(4) var<storage, read> vertices: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> accumulated: array<vec4f>;
@group(0) @binding(6) var output: texture_storage_2d<rgba16float, write>;
struct Bake { size: vec4u, samples: vec4u }
@group(0) @binding(7) var<uniform> bake: Bake;

fn surfacePoint(chart: Chart, uv: vec2f) -> vec3f {
  let p = chart.origin.xyz + chart.u.xyz * (uv.x * chart.u.w) + chart.v.xyz * (uv.y * chart.v.w);
  var closest = p; var best = 1e30; var outside = false;
  let start = u32(chart.polygon.x); let count = u32(chart.polygon.y);
  // Bake gutter and outside-polygon samples at their closest boundary point.
  for (var i = 0u; i < count; i++) {
    let a = vertices[start + i].xyz; let b = vertices[start + (i + 1u) % count].xyz;
    let edge = b - a; let side = dot(cross(edge, p - a), chart.normal.xyz);
    outside = outside || side < -0.00001;
    let q = a + edge * clamp(dot(p - a, edge) / max(dot(edge, edge), 1e-12), 0.0, 1.0);
    let distance = dot(p - q, p - q);
    if (distance < best) { best = distance; closest = q; }
  }
  return select(p, closest, outside);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= bake.size.x || id.y >= bake.size.x) { return; }
  let chartIndex = id.x / ${LIGHTMAP_TILE}u + id.y / ${LIGHTMAP_TILE}u * bake.size.y;
  if (chartIndex >= bake.size.z) { textureStore(output, id.xy, vec4f(0.0)); return; }
  let chart = charts[chartIndex];
  if (chart.polygon.y < 3.0) { textureStore(output, id.xy, vec4f(0.0)); return; }
  let at = id.y * bake.size.x + id.x;
  let pixel = vec2f(id.xy % vec2u(${LIGHTMAP_TILE}u)) - 1.0;
  let uv = clamp(pixel / ${LIGHTMAP_TEXELS - 1}.0, vec2f(0.0), vec2f(1.0));
  let point = surfacePoint(chart, uv) + chart.normal.xyz * 0.003;
  var sum = vec3f(0.0);
  if (bake.samples.x > 0u) { sum = accumulated[at].rgb; }
  for (var sample = bake.samples.x; sample < bake.samples.x + bake.samples.y; sample++) {
    var seed = at * 19349663u + sample * 83492791u + 7151u;
    let direction = hemisphere(chart.normal.xyz, &seed);
    sum += radiance(point, direction, bake.size.w, vec3f(0.0), &seed);
  }
  accumulated[at] = vec4f(sum, 0.0);
  textureStore(output, id.xy, vec4f(sum / f32(bake.samples.x + bake.samples.y), 1.0));
}
`;
