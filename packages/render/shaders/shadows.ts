/**
 * Shadow hooks called by the light loop (lighting.ts).
 *
 *   sunShadow(lightIndex, world, n, nl, frag)    shadowing directional lights:
 *       cascaded maps, blue-noise rotated Vogel PCF, PCSS penumbrae
 *   localShadow(lightIndex, world, n, nl, frag)   every other light with a
 *       shadow slot (lights[i].extra.z >= 0): spot tiles of the atlas and
 *       point light cubes, filtered the same way
 *   debugView(color, ao)                          Overlays.debug tinting
 *
 * `n` is the shading normal, `nl` = max(dot(n, l), 0), `frag` the fragment's
 * device-pixel position (with blueNoise(frag) it rotates the kernels).
 *
 * Bias: the receiver is pushed along its normal by a few shadow texels, and
 * every filter tap compares against the depth of the receiver *plane* at the
 * tap's own position (exact for planes, so wide penumbra kernels do not
 * self-shadow), minus a fraction of a texel. No constant depth bias that
 * would detach shadows from their casters.
 *
 * Penumbra: the sun is a disc of angular diameter tan = 0.06 * softness; local
 * lights are discs of diameter 0.25 m * softness. A blocker search over the
 * map gives the average blocker depth; the penumbra width follows by similar
 * triangles, so shadows are hard at contact and soften with distance from
 * the occluder. Softness 0 skips the search and filters over ~1 texel.
 *
 * Local shadow records live in the shadowMatrices buffer (binding 12), two
 * mat4x4f per slot r = lights[i].extra.z:
 *   [2r]    spot: world -> light clip (perspective); point: unused
 *   [2r+1]  col 0 atlas tile (u0, v0, du, dv); col 1 (near, far, tan half fov,
 *           tile size in texels | cube index); col 2 right, col 3 up (spot)
 */
import { common } from "./common.ts";

export const shadowsWgsl = /* wgsl */ `
const SHADOW_EDGE: f32 = 0.92;
const SHADOW_BLEND: f32 = 0.78;
const GOLDEN_C: f32 = -0.7373688780783197;
const GOLDEN_S: f32 = 0.6754902942615238;
const SUN_TAN: f32 = 0.06;
const LOCAL_SIZE: f32 = 0.25;

// Cascade index of the last sunShadow call (-1: none), for Overlays.debug.
var<private> debugCascade: f32 = -1.0;

fn linearDepth(z: f32, near: f32, far: f32) -> f32 {
  return near * far / (far - z * (far - near));
}

fn nonlinearDepth(d: f32, near: f32, far: f32) -> f32 {
  return far * (d - near) / (d * (far - near));
}

fn maxAbs3(v: vec3f) -> f32 {
  return max(abs(v.x), max(abs(v.y), abs(v.z)));
}

// One cascade: (visibility, border metric). The metric is the larger of
// |x|, |y| in cascade clip space (2 when the point is outside the cascade).
fn sunCascade(i: i32, world: vec3f, n: vec3f, nl: f32, rot: vec2f, softness: f32) -> vec2f {
  let m = frame.cascades[i];
  let rx = vec3f(m[0][0], m[1][0], m[2][0]);
  let ry = vec3f(m[0][1], m[1][1], m[2][1]);
  let rz = vec3f(m[0][2], m[1][2], m[2][2]);
  let halfExtent = 1.0 / length(rx);
  let depthLength = 1.0 / length(rz);
  let size = frame.shadow.x;
  let texelW = 2.0 * halfExtent / size;
  let p0 = world + n * (texelW * (1.0 + 1.5 * (1.0 - nl)));
  let lp = m * vec4f(p0, 1.0);
  let edge = max(abs(lp.x), abs(lp.y));
  if (edge >= SHADOW_EDGE || lp.z > 1.0) { return vec2f(1.0, 2.0); }
  let uv = vec2f(lp.x * 0.5 + 0.5, 0.5 - lp.y * 0.5);

  // Receiver plane: depth change per uv offset (light travels along sunDir).
  let ex = rx * halfExtent;
  let ey = ry * halfExtent;
  let slope = clamp(vec2f(dot(n, ex), dot(n, ey)) / max(nl, 0.12), vec2f(-8.0), vec2f(8.0));
  let slopeUv = vec2f(slope.x, -slope.y) * (2.0 * halfExtent / depthLength);
  let zr = lp.z - 0.5 * texelW / depthLength;

  var taps = 4;
  var radius = 0.8 / size;
  var c = rot.x;
  var s = rot.y;
  if (softness > 0.001) {
    taps = max(i32(frame.shadow.z), 1);
    let tanT = SUN_TAN * softness;
    let search = clamp(tanT * 5.0 / (2.0 * halfExtent), 2.0 / size, 0.06);
    let bt = max(i32(frame.shadow.w), 1);
    var sum = 0.0;
    var count = 0.0;
    for (var k = 0; k < bt; k = k + 1) {
      let o = vec2f(c, s) * (sqrt((f32(k) + 0.5) / f32(bt)) * search);
      let texel = vec2i(clamp((uv + o) * size, vec2f(0.0), vec2f(size - 1.0)));
      let sd = textureLoad(sunShadowMap, texel, i, 0);
      if (sd < zr + dot(slopeUv, o)) {
        sum += sd;
        count += 1.0;
      }
      let nc = c * GOLDEN_C - s * GOLDEN_S;
      s = c * GOLDEN_S + s * GOLDEN_C;
      c = nc;
    }
    if (count < 0.5) { return vec2f(1.0, edge); }
    let width = (zr - sum / count) * depthLength * tanT;
    radius = clamp(width * 0.25 / halfExtent, 1.25 / size, 0.05);
    c = rot.x;
    s = rot.y;
  }
  var vis = 0.0;
  for (var k = 0; k < taps; k = k + 1) {
    let o = vec2f(c, s) * (sqrt((f32(k) + 0.5) / f32(taps)) * radius);
    vis += textureSampleCompareLevel(sunShadowMap, shadowSampler, uv + o, i, zr + dot(slopeUv, o));
    let nc = c * GOLDEN_C - s * GOLDEN_S;
    s = c * GOLDEN_S + s * GOLDEN_C;
    c = nc;
  }
  return vec2f(vis / f32(taps), edge);
}

fn sunShadow(lightIndex: i32, world: vec3f, n: vec3f, nl: f32, frag: vec2f) -> f32 {
  if (frame.params.z < 0.5 || lights[lightIndex].extra.z < 0.0) { return 1.0; }
  let base = i32(lights[lightIndex].extra.z);
  let count = i32(frame.shadow.y);
  let depth = dot(world - frame.cameraPos.xyz, frame.cameraDir.xyz);
  let far = frame.cascadeSplits[count - 1];
  if (depth > far) { return 1.0; }
  let angle = blueNoise(frag) * 2.0 * PI;
  let rot = vec2f(cos(angle), sin(angle));
  let softness = lights[lightIndex].extra.y;
  var vis = 1.0;
  for (var i = 0; i < count; i = i + 1) {
    let r = sunCascade(base + i, world, n, nl, rot, softness);
    if (r.y < SHADOW_EDGE) {
      debugCascade = f32(i);
      vis = r.x;
      let t = smoothstep(SHADOW_BLEND, SHADOW_EDGE, r.y);
      if (t > 0.0) {
        if (i + 1 < count) {
          vis = mix(vis, sunCascade(base + i + 1, world, n, nl, rot, softness).x, t);
        } else {
          vis = mix(vis, 1.0, t);
        }
      }
      break;
    }
  }
  // Fade out at the shadow distance (an orthographic view has no distance).
  var fade = 0.0;
  if (frame.cameraPos.w < 0.5) {
    fade = smoothstep(0.88 * frame.time.w, frame.time.w, depth);
  }
  return mix(vis, 1.0, fade);
}

// Depth along the light's axis where the ray through spot tile uv meets the
// receiver plane (n . x = nRel, relative to the light).
fn spotPlaneDepth(uv: vec2f, tanHalf: f32, right: vec3f, up: vec3f, fwd: vec3f, n: vec3f, nRel: f32, d0: f32) -> f32 {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let ray = fwd + right * (ndc.x * tanHalf) + up * (ndc.y * tanHalf);
  let den = dot(n, ray);
  if (den < -1e-3) { return clamp(nRel / den, d0 * 0.7, d0 * 1.4); }
  return d0;
}

fn spotShadow(light: Light, world: vec3f, n: vec3f, nl: f32, rot: vec2f) -> f32 {
  let rec = i32(light.extra.z);
  let d1 = shadowMatrices[2 * rec + 1];
  let tile = d1[0];
  let near = d1[1].x;
  let far = d1[1].y;
  let tanHalf = d1[1].z;
  let tilePx = d1[1].w;
  let right = d1[2].xyz;
  let up = d1[3].xyz;
  let fwd = light.dirCone.xyz;
  let lp = light.posType.xyz;
  let d = dot(world - lp, fwd);
  if (d <= near) { return 1.0; }
  let texelW = 2.0 * d * tanHalf / tilePx;
  let p0 = world + n * (texelW * (1.0 + 1.5 * (1.0 - nl)));
  let rel = p0 - lp;
  let d0 = dot(rel, fwd);
  if (d0 <= near || d0 >= far) { return 1.0; }
  let ndc = vec2f(dot(rel, right), dot(rel, up)) / (d0 * tanHalf);
  if (max(abs(ndc.x), abs(ndc.y)) >= 1.0) { return 1.0; }
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let atlas = vec2f(textureDimensions(spotShadowAtlas));
  let nRel = dot(n, rel);
  let size = LOCAL_SIZE * light.extra.y;
  let bias = 0.5 * texelW;
  let edge = 1.5 / tilePx;

  var taps = 4;
  var radius = 0.8 / tilePx;
  var c = rot.x;
  var s = rot.y;
  if (size > 0.001) {
    taps = max(i32(frame.shadow.z), 1);
    let search = clamp(0.75 * size / (d0 * tanHalf), 3.0 / tilePx, 0.08);
    let bt = max(i32(frame.shadow.w), 1);
    var sum = 0.0;
    var count = 0.0;
    for (var k = 0; k < bt; k = k + 1) {
      let o = vec2f(c, s) * (sqrt((f32(k) + 0.5) / f32(bt)) * search);
      let t = clamp(uv + o, vec2f(edge), vec2f(1.0 - edge));
      let texel = vec2i((tile.xy + t * tile.zw) * atlas);
      let db = linearDepth(textureLoad(spotShadowAtlas, texel, 0), near, far);
      if (db < spotPlaneDepth(t, tanHalf, right, up, fwd, n, nRel, d0) - bias) {
        sum += db;
        count += 1.0;
      }
      let nc = c * GOLDEN_C - s * GOLDEN_S;
      s = c * GOLDEN_S + s * GOLDEN_C;
      c = nc;
    }
    if (count < 0.5) { return 1.0; }
    let avg = sum / count;
    let width = size * max(d0 - avg, 0.0) / avg;
    radius = clamp(width * 0.25 / (d0 * tanHalf), 1.25 / tilePx, 0.08);
    c = rot.x;
    s = rot.y;
  }
  var vis = 0.0;
  for (var k = 0; k < taps; k = k + 1) {
    let o = vec2f(c, s) * (sqrt((f32(k) + 0.5) / f32(taps)) * radius);
    let t = clamp(uv + o, vec2f(edge), vec2f(1.0 - edge));
    let refZ = nonlinearDepth(spotPlaneDepth(t, tanHalf, right, up, fwd, n, nRel, d0) - bias, near, far);
    vis += textureSampleCompareLevel(spotShadowAtlas, shadowSampler, tile.xy + t * tile.zw, refZ);
    let nc = c * GOLDEN_C - s * GOLDEN_S;
    s = c * GOLDEN_S + s * GOLDEN_C;
    c = nc;
  }
  return vis / f32(taps);
}

// Cube face and uv of a direction, in the hardware's layout.
fn cubeFaceUv(v: vec3f) -> vec3f {
  let a = abs(v);
  var face = 0.0;
  var sc = 0.0;
  var tc = 0.0;
  var ma = a.x;
  if (a.x >= a.y && a.x >= a.z) {
    ma = a.x;
    if (v.x > 0.0) { face = 0.0; sc = -v.z; tc = -v.y; } else { face = 1.0; sc = v.z; tc = -v.y; }
  } else if (a.y >= a.z) {
    ma = a.y;
    if (v.y > 0.0) { face = 2.0; sc = v.x; tc = v.z; } else { face = 3.0; sc = v.x; tc = -v.z; }
  } else {
    ma = a.z;
    if (v.z > 0.0) { face = 4.0; sc = v.x; tc = -v.y; } else { face = 5.0; sc = -v.x; tc = -v.y; }
  }
  return vec3f(face, (sc / ma + 1.0) * 0.5, (tc / ma + 1.0) * 0.5);
}

// Major-axis distance where the ray along dir (from the light) meets the
// receiver plane through v with normal n.
fn pointPlaneDepth(dir: vec3f, n: vec3f, nRel: f32, scale: f32) -> f32 {
  let den = dot(n, dir);
  var k = 1.0;
  if (den < -1e-3 * scale) { k = clamp(nRel / den, 0.7, 1.4); }
  return maxAbs3(dir) * k;
}

fn pointShadow(light: Light, world: vec3f, n: vec3f, nl: f32, rot: vec2f) -> f32 {
  let rec = i32(light.extra.z);
  let d1 = shadowMatrices[2 * rec + 1];
  let near = d1[1].x;
  let far = d1[1].y;
  let cube = i32(d1[1].w);
  let lp = light.posType.xyz;
  let res = f32(textureDimensions(pointShadowCubes).x);
  let major = maxAbs3(world - lp);
  if (major <= near) { return 1.0; }
  let texelW = 2.0 * major / res;
  let p0 = world + n * (texelW * (1.0 + 1.5 * (1.0 - nl)));
  let v = p0 - lp;
  let dist = length(v);
  if (maxAbs3(v) >= far || maxAbs3(v) <= near) { return 1.0; }
  let nRel = dot(n, v);
  let size = LOCAL_SIZE * light.extra.y;
  let bias = 0.5 * texelW;
  let dir = v / dist;
  var helper = vec3f(0.0, 1.0, 0.0);
  if (abs(dir.y) > 0.9) { helper = vec3f(1.0, 0.0, 0.0); }
  let t1 = normalize(cross(dir, helper));
  let t2 = cross(dir, t1);

  var taps = 4;
  var radius = 0.8 * texelW;
  var c = rot.x;
  var s = rot.y;
  if (size > 0.001) {
    taps = max(i32(frame.shadow.z), 1);
    let search = min(0.75 * size, 0.4 * dist);
    let bt = max(i32(frame.shadow.w), 1);
    var sum = 0.0;
    var count = 0.0;
    for (var k = 0; k < bt; k = k + 1) {
      let o = vec2f(c, s) * (sqrt((f32(k) + 0.5) / f32(bt)) * search);
      let tap = v + t1 * o.x + t2 * o.y;
      let fu = cubeFaceUv(tap);
      let texel = vec2i(clamp(fu.yz * res, vec2f(0.0), vec2f(res - 1.0)));
      let sd = textureLoad(pointShadowFaces, texel, cube * 6 + i32(fu.x), 0);
      let db = linearDepth(sd, near, far);
      if (db < pointPlaneDepth(tap, n, nRel, dist) - bias) {
        sum += db * length(tap) / maxAbs3(tap);
        count += 1.0;
      }
      let nc = c * GOLDEN_C - s * GOLDEN_S;
      s = c * GOLDEN_S + s * GOLDEN_C;
      c = nc;
    }
    if (count < 0.5) { return 1.0; }
    let avg = sum / count;
    let width = size * max(dist - avg, 0.0) / avg;
    radius = clamp(width * 0.5, 1.25 * texelW, 0.5 * dist);
    c = rot.x;
    s = rot.y;
  }
  var vis = 0.0;
  for (var k = 0; k < taps; k = k + 1) {
    let o = vec2f(c, s) * (sqrt((f32(k) + 0.5) / f32(taps)) * radius);
    let tap = v + t1 * o.x + t2 * o.y;
    let refZ = nonlinearDepth(pointPlaneDepth(tap, n, nRel, dist) - bias, near, far);
    vis += textureSampleCompareLevel(pointShadowCubes, shadowSampler, tap, cube, refZ);
    let nc = c * GOLDEN_C - s * GOLDEN_S;
    s = c * GOLDEN_S + s * GOLDEN_C;
    c = nc;
  }
  return vis / f32(taps);
}

fn localShadow(lightIndex: i32, world: vec3f, n: vec3f, nl: f32, frag: vec2f) -> f32 {
  let light = lights[lightIndex];
  let angle = blueNoise(frag) * 2.0 * PI;
  let rot = vec2f(cos(angle), sin(angle));
  if (light.posType.w > 1.5) { return spotShadow(light, world, n, nl, rot); }
  return pointShadow(light, world, n, nl, rot);
}

// Overlays.debug: tint by cascade, or show the ambient occlusion factor.
fn debugView(color: vec3f, ao: f32) -> vec3f {
  let mode = i32(frame.debug.x + 0.5);
  if (mode == 1 && debugCascade > -0.5) {
    var tint = vec3f(1.0, 0.35, 0.3);
    let i = i32(debugCascade + 0.5);
    if (i == 1) { tint = vec3f(0.4, 1.0, 0.4); }
    if (i == 2) { tint = vec3f(0.4, 0.6, 1.0); }
    if (i == 3) { tint = vec3f(1.0, 0.9, 0.3); }
    return color * mix(vec3f(1.0), tint, 0.7);
  }
  if (mode == 2) { return vec3f(ao * 2.0); }
  return color;
}
`;

/** Overlays.debug = "shadow-atlas": thumbnails of the sun cascades and the
 * spot atlas in the top-left corner of the overlay layer. */
export const shadowDebugShader = /* wgsl */ `
${common}

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  return fullscreenPosition(vi);
}

fn shade(d: f32) -> vec4f {
  let g = pow(clamp(d, 0.0, 1.0), 2.2);
  return vec4f(g, g, g, 1.0);
}

@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let size = min(frame.viewport.x, frame.viewport.y) * 0.2;
  let gap = 6.0 * frame.viewport.z;
  let p = frag.xy - vec2f(gap);
  if (p.x < 0.0 || p.y < 0.0) { discard; }
  if (frame.systems.x > 0.5) {
    let count = i32(frame.shadow.y);
    let i = i32(floor(p.x / (size + gap)));
    let lx = p.x - f32(i) * (size + gap);
    if (p.y < size && i < count && lx < size) {
      let dims = vec2f(textureDimensions(sunShadowMap));
      return shade(textureLoad(sunShadowMap, vec2i(vec2f(lx, p.y) / size * dims), i, 0));
    }
  }
  if (frame.systems.w > 0.5) {
    let dims = vec2f(textureDimensions(spotShadowAtlas));
    let width = size * 2.0;
    let height = width * dims.y / dims.x;
    let q = vec2f(p.x, p.y - size - gap);
    if (q.x >= 0.0 && q.y >= 0.0 && q.x < width && q.y < height) {
      return shade(pow(textureLoad(spotShadowAtlas, vec2i(q / vec2f(width, height) * dims), 0), 24.0));
    }
  }
  discard;
  return vec4f(0.0);
}
`;
