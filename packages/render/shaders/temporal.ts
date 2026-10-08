import { common } from "./common.ts";
import { instanceWgsl } from "./instance.ts";

export const motionShader = /* wgsl */ `
${common}
${instanceWgsl}
@group(1) @binding(0) var materialSampler: sampler;
@group(1) @binding(1) var baseTexture: texture_2d<f32>;
struct MotionCamera { current: mat4x4f, previous: mat4x4f, previousView: mat4x4f }
@group(3) @binding(0) var<uniform> motionCamera: MotionCamera;
@group(3) @binding(1) var<storage, read> previous: array<Instance>;
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) current: vec4f,
  @location(1) previous: vec4f,
  @location(2) depths: vec2f,
  @location(3) uv: vec2f,
  @location(4) alpha: f32,
  @location(5) @interpolate(flat) inst: u32,
}
@vertex fn vs(
  @location(0) pos: vec3f, @location(2) uv: vec2f,
  @location(3) color: vec4f, @location(5) indices: vec4u,
  @location(6) weights: vec4f, @location(7) uv1: vec2f,
  @location(8) indices1: vec4u, @location(9) weights1: vec4f,
  @builtin(instance_index) i: u32, @builtin(vertex_index) vertex: u32,
) -> Out {
  let inst = instances[i]; let old = previous[i];
  let world = inst.model * skinPosition(inst, pos + morphDelta(inst, vertex, 0u), indices, weights, indices1, weights1);
  let last = old.model * skinPosition(old, pos + morphDelta(old, vertex, 0u), indices, weights, indices1, weights1);
  var o: Out;
  o.clip = frame.viewProj * world;
  o.current = motionCamera.current * world;
  o.previous = motionCamera.previous * last;
  o.depths = vec2f(-(motionCamera.previousView * last).z, -(frame.view * world).z);
  o.uv = materialUv(inst, uv, uv1, 0u) * inst.params.yz;
  o.alpha = inst.color.a * color.a;
  o.inst = i;
  return o;
}
@fragment fn fs(v: Out) -> @location(0) vec4f {
  clipAlpha(instances[v.inst], v.alpha * textureSampleLevel(baseTexture, materialSampler, v.uv, 0.0).a);
  let a = v.current.xy / v.current.w;
  let b = v.previous.xy / max(v.previous.w, 1e-6);
  let valid = v.previous.w > 0.0 && previous[v.inst].ids.y == 0u;
  return vec4f((a - b) * vec2f(0.5, -0.5), select(-1.0, v.depths.x, valid), v.depths.y);
}
`;

/** Reprojection with depth rejection and neighbourhood variance clipping.
 * The resolve runs at output resolution; current samples can be half size. */
export const temporalShader = /* wgsl */ `
struct Temporal {
  inverseCurrent: mat4x4f,
  previous: mat4x4f,
  camera: vec4f,
  size: vec4f,       // output xy, input zw
  state: vec4f,      // input-pixel jitter xy, valid history z, perspective w
}
@group(0) @binding(0) var current: texture_2d<f32>;
@group(0) @binding(1) var velocity: texture_2d<f32>;
@group(0) @binding(2) var history: texture_2d<f32>;
@group(0) @binding(3) var historyDepth: texture_2d<f32>;
@group(0) @binding(4) var translucent: texture_2d<f32>;
@group(0) @binding(5) var linearSampler: sampler;
@group(0) @binding(6) var<uniform> u: Temporal;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
fn currentAt(p: vec2i) -> vec3f {
  return textureLoad(current, clamp(p, vec2i(0), vec2i(u.size.zw) - 1), 0).rgb;
}
// Separable Catmull-Rom reconstruction: combine the two positive middle
// weights into one bilinear fetch. This avoids repeated bilinear blurring as
// history follows a moving subpixel edge, and retains detail when upscaling.
fn reconstruct(image: texture_2d<f32>, uv: vec2f) -> vec4f {
  let size = vec2f(textureDimensions(image));
  let at = uv * size - 0.5;
  let base = floor(at); let f = fract(at); let f2 = f * f; let f3 = f2 * f;
  let w0 = -0.5 * f + f2 - 0.5 * f3;
  let w1 = 1.0 - 2.5 * f2 + 1.5 * f3;
  let w2 = 0.5 * f + 2.0 * f2 - 1.5 * f3;
  let w3 = -0.5 * f2 + 0.5 * f3;
  let middle = w1 + w2;
  let wx = vec3f(w0.x, middle.x, w3.x);
  let wy = vec3f(w0.y, middle.y, w3.y);
  let px = (vec3f(base.x - 1.0, base.x + w2.x / middle.x, base.x + 2.0) + 0.5) / size.x;
  let py = (vec3f(base.y - 1.0, base.y + w2.y / middle.y, base.y + 2.0) + 0.5) / size.y;
  var result = vec4f(0.0);
  for (var y = 0u; y < 3u; y++) {
    for (var x = 0u; x < 3u; x++) {
      result += textureSampleLevel(image, linearSampler, vec2f(px[x], py[y]), 0.0) * wx[x] * wy[y];
    }
  }
  return result;
}
struct Result { @location(0) color: vec4f, @location(1) depth: f32 }
@fragment fn fs(@builtin(position) frag: vec4f) -> Result {
  let uv = frag.xy / u.size.xy;
  let sampleUv = uv + u.state.xy / u.size.zw;
  let p = clamp(vec2i(sampleUv * u.size.zw), vec2i(0), vec2i(u.size.zw) - 1);
  let motion = textureLoad(velocity, p, 0);
  var previousUv = uv - motion.xy;
  if (motion.w == 0.0 && u.state.w > 0.5) {
    let h = u.inverseCurrent * vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 1.0, 1.0);
    let direction = h.xyz / h.w - u.camera.xyz;
    let old = u.previous * vec4f(direction, 0.0);
    previousUv = old.xy / max(old.w, 1e-6) * vec2f(0.5, -0.5) + 0.5;
  }
  let fresh = reconstruct(current, sampleUv).rgb;
  var minimum = vec3f(1e10); var maximum = vec3f(-1e10);
  var mean = vec3f(0.0); var squared = vec3f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = currentAt(p + vec2i(x, y));
      minimum = min(minimum, c); maximum = max(maximum, c);
      mean += c / 9.0; squared += c * c / 9.0;
    }
  }
  let deviation = sqrt(max(vec3f(0.0), squared - mean * mean));
  let lo = max(minimum, mean - 1.5 * deviation);
  let hi = min(maximum, mean + 1.5 * deviation);
  let old = reconstruct(history, previousUv);
  let hp = clamp(vec2i(previousUv * u.size.xy), vec2i(0), vec2i(u.size.xy) - 1);
  let oldDepth = textureLoad(historyDepth, hp, 0).r;
  let visible = all(previousUv >= vec2f(0.0)) && all(previousUv < vec2f(1.0));
  let depthMatches = abs(oldDepth - motion.z) < max(0.015, motion.z * 0.015);
  let transparentSize = vec2i(textureDimensions(translucent));
  let trans = textureLoad(translucent, clamp(p, vec2i(0), transparentSize - 1), 0);
  let reactive = clamp(max(trans.a, max(trans.r, max(trans.g, trans.b))), 0.0, 1.0);
  let valid = u.state.z > 0.5 && visible && motion.z >= 0.0 && depthMatches;
  let count = select(0.0, clamp(old.a, 0.0, 31.0), valid);
  let speed = length(motion.xy * u.size.xy);
  let weight = min(count / (count + 1.0), mix(0.95, 0.75, clamp(speed / 16.0, 0.0, 1.0))) * (1.0 - reactive);
  var out: Result;
  out.color = vec4f(mix(clamp(fresh, minimum, maximum), clamp(old.rgb, lo, hi), weight), count + 1.0);
  out.depth = motion.w;
  return out;
}
`;
