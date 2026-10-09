import { cubeCoordinatesWgsl } from "./ibl.ts";
import { traceWgsl } from "./lightmaps.ts";

export const probeStruct = /* wgsl */ `
struct Probe { local: mat4x4f, world: mat4x4f, extent: vec4f, position: vec4f }
`;

export const probeWgsl = /* wgsl */ `
${probeStruct}
@group(0) @binding(17) var probeCubes: texture_cube_array<f32>;
@group(0) @binding(18) var<storage, read> probes: array<Probe>;
fn sceneReflection(world: vec3f, direction: vec3f, roughness: f32, fallback: vec3f) -> vec3f {
  var reflected = vec3f(0.0); var weight = 0.0;
  for (var i = 0u; i < u32(frame.gi.y); i++) {
    let probe = probes[i]; let p = (probe.local * vec4f(world, 1.0)).xyz;
    let distance = probe.extent.xyz - abs(p);
    if (any(distance < vec3f(0.0))) { continue; }
    let w = clamp(min(min(distance.x, distance.y), distance.z) / max(probe.extent.w, 0.001), 0.0, 1.0);
    let d = (probe.local * vec4f(direction, 0.0)).xyz;
    let inv = sign(d + vec3f(1e-20)) / max(abs(d), vec3f(1e-20));
    let exit = max((-probe.extent.xyz - p) * inv, (probe.extent.xyz - p) * inv);
    let t = min(min(exit.x, exit.y), exit.z);
    let hit = (probe.world * vec4f(p + d * t, 1.0)).xyz - probe.position.xyz;
    reflected += textureSampleLevel(probeCubes, linearSampler, hit, i32(i), roughness * (frame.gi.z - 1.0)).rgb * (w * probe.position.w);
    weight += w;
  }
  return mix(fallback, reflected / max(weight, 1e-6), min(weight, 1.0));
}
`;

export const probeBakeShader = /* wgsl */ `
${probeStruct}
${cubeCoordinatesWgsl}
${traceWgsl}
@group(0) @binding(3) var<storage, read> probes: array<Probe>;
@group(0) @binding(4) var<storage, read_write> accumulated: array<vec4f>;
@group(0) @binding(5) var output: texture_storage_2d_array<rgba16float, write>;
struct Settings { samples: vec4u, sky: vec4f }
@group(0) @binding(6) var<uniform> settings: Settings;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(output).x;
  if (id.x >= size || id.y >= size) { return; }
  let at = (id.z * size + id.y) * size + id.x;
  let probe = probes[id.z / 6u];
  var sum = vec3f(0.0);
  if (settings.samples.x > 0u) { sum = accumulated[at].rgb; }
  for (var sample = settings.samples.x; sample < settings.samples.x + settings.samples.y; sample++) {
    var seed = at * 19349663u + sample * 83492791u + 9151u;
    let jitter = vec2f(random(&seed), random(&seed));
    let uv = (vec2f(id.xy) + jitter) / f32(size) * 2.0 - 1.0;
    sum += radiance(probe.position.xyz, cubeDir(id.z % 6u, uv), settings.samples.z, settings.sky.rgb, &seed);
  }
  accumulated[at] = vec4f(sum, 0.0);
  textureStore(output, id.xy, id.z, vec4f(sum / f32(settings.samples.x + settings.samples.y), 1.0));
}
`;
