import { common } from "./common.ts";
import { hdrWgsl } from "./hdr.ts";

export const ssrShader = /* wgsl */ `
${common}
${hdrWgsl}
@group(1) @binding(0) var scene: texture_2d<f32>;
@group(1) @binding(1) var geometry: texture_2d<f32>;
@group(1) @binding(2) var material: texture_2d<f32>;
@group(1) @binding(3) var fallback: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
fn projected(p: vec3f) -> vec3f {
  let clip = frame.viewProj * vec4f(p, 1.0);
  return vec3f(clip.xy / clip.w * vec2f(0.5, -0.5) + 0.5, -(frame.view * vec4f(p, 1.0)).z);
}
@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let pixel = vec2i(frag.xy); let size = vec2f(textureDimensions(scene));
  let original = textureLoad(scene, pixel, 0);
  let g = textureLoad(geometry, pixel, 0); let m = textureLoad(material, pixel, 0);
  if (g.w <= 0.0 || m.w >= 0.65 || max(max(m.r, m.g), m.b) < 0.001) { return original; }
  let ndc = frag.xy / size * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let a = frame.invViewProj * vec4f(ndc, 0.0, 1.0);
  let b = frame.invViewProj * vec4f(ndc, 1.0, 1.0);
  let start = a.xyz / a.w; let cameraRay = normalize(b.xyz / b.w - start);
  let nearDepth = -(frame.view * vec4f(start, 1.0)).z;
  let world = start + cameraRay * ((g.w - nearDepth) / dot(cameraRay, frame.cameraDir.xyz));
  let direction = reflect(cameraRay, g.xyz);
  let origin = world + g.xyz * 0.015;
  var distance = 0.04; var previous = 0.0;
  for (var step = 0u; step < 72u; step++) {
    let at = projected(origin + direction * distance);
    if (at.z <= 0.01 || any(at.xy < vec2f(0.0)) || any(at.xy >= vec2f(1.0))) { break; }
    let hit = textureLoad(geometry, vec2i(at.xy * size), 0);
    let delta = at.z - hit.w;
    let thickness = max(0.08, hit.w * 0.008);
    if (hit.w > 0.0 && delta > 0.0 && delta < thickness + distance - previous) {
      var lo = previous; var hi = distance; var uv = at.xy;
      for (var refine = 0u; refine < 6u; refine++) {
        let t = (lo + hi) * 0.5; let point = projected(origin + direction * t);
        let depth = textureLoad(geometry, clamp(vec2i(point.xy * size), vec2i(0), vec2i(size) - 1), 0).w;
        if (depth > 0.0 && point.z > depth) { hi = t; uv = point.xy; } else { lo = t; }
      }
      let end = projected(origin + direction * hi);
      let surface = textureLoad(geometry, clamp(vec2i(uv * size), vec2i(0), vec2i(size) - 1), 0);
      if (abs(end.z - surface.w) < thickness && dot(surface.xyz, direction) < -0.01 && hi > 0.08) {
        let edge = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
        let confidence = smoothstep(0.0, 0.08, edge) * (1.0 - smoothstep(0.3, 0.65, m.w)) * frame.gi.w;
        let reflected = unpackHdr(textureSampleLevel(scene, linearSampler, uv, 0.0).rgb);
        let old = textureLoad(fallback, pixel, 0).rgb;
        let color = max(vec3f(0.0), unpackHdr(original.rgb) + confidence * (reflected * m.rgb - old));
        return vec4f(packHdr(color), original.a);
      }
    }
    previous = distance; distance = distance * 1.08 + 0.04;
  }
  return original;
}
`;
