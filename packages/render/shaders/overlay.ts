/** Thick lines, translucent fills and the analytic grid. */
import { common } from "./common.ts";

export const overlayShader = /* wgsl */ `
${common}

// Lines ------------------------------------------------------------------------

struct LineData {
  a: vec4f,      // xyz start, w width in css px
  b: vec4f,      // xyz end
  color: vec4f,  // linear rgb, a opacity
}
@group(1) @binding(0) var<storage, read> lines: array<LineData>;

struct LineOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec4f,
  @location(1) dist: f32,
  @location(2) half: f32,
}

const LINE_BIAS: f32 = 0.00004;

@vertex fn vsLine(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LineOut {
  let l = lines[ii];
  var ca = frame.viewProj * vec4f(l.a.xyz, 1.0);
  var cb = frame.viewProj * vec4f(l.b.xyz, 1.0);
  var o: LineOut;
  o.color = l.color;
  o.dist = 0.0;
  o.half = 0.0;
  // Clip the segment to the near plane (clip z >= 0); cull what is behind it.
  if (ca.z < 0.0 && cb.z < 0.0) {
    o.clip = vec4f(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  if (ca.z < 0.0) { ca = mix(ca, cb, ca.z / (ca.z - cb.z)); }
  if (cb.z < 0.0) { cb = mix(cb, ca, cb.z / (cb.z - ca.z)); }
  let half = vec2f(frame.viewport.xy) * 0.5;
  let sa = ca.xy / ca.w * half;
  let sb = cb.xy / cb.w * half;
  var dir = sb - sa;
  let len = length(dir);
  if (len < 1e-4) { dir = vec2f(1.0, 0.0); } else { dir = dir / len; }
  let nrm = vec2f(-dir.y, dir.x);
  let core = max(l.a.w * frame.viewport.z, 1.0) * 0.5;
  let fringe = core + 1.0;
  var corners = array<vec2f, 6>(
    vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let c = corners[vi];
  let end = c.x > 0.5;
  let p = select(ca, cb, end);
  let sp = p.xy / p.w * half;
  let along = select(-core, core, end);
  let screen = sp + nrm * (c.y * fringe) + dir * along;
  o.clip = vec4f(screen / half * p.w, p.z - LINE_BIAS * p.w, p.w);
  o.dist = c.y * fringe;
  o.half = core;
  return o;
}

@fragment fn fsLine(v: LineOut) -> @location(0) vec4f {
  let coverage = clamp(v.half + 0.5 - abs(v.dist), 0.0, 1.0);
  return vec4f(v.color.rgb, v.color.a * coverage);
}

// Fills ------------------------------------------------------------------------

struct FillVertex { pos: vec4f, color: vec4f }
@group(1) @binding(1) var<storage, read> fills: array<FillVertex>;

struct FillOut { @builtin(position) clip: vec4f, @location(0) color: vec4f }

@vertex fn vsFill(@builtin(vertex_index) vi: u32) -> FillOut {
  let f = fills[vi];
  var o: FillOut;
  let c = frame.viewProj * vec4f(f.pos.xyz, 1.0);
  o.clip = vec4f(c.xy, c.z - 0.0002 * c.w, c.w);
  o.color = f.color;
  return o;
}

@fragment fn fsFill(v: FillOut) -> @location(0) vec4f {
  return v.color;
}

// Grid -------------------------------------------------------------------------

struct Grid {
  info: vec4f,        // x plane (0 xz, 1 xy, 2 yz), y spacing, z major, w unused
  minor: vec4f,
  major: vec4f,
  axisA: vec4f,       // colour of the line where the first plane coordinate is 0
  axisB: vec4f,       // colour of the line where the second plane coordinate is 0
}
@group(1) @binding(2) var<uniform> grid: Grid;

struct GridOut { @builtin(position) clip: vec4f, @location(0) ndc: vec2f }

@vertex fn vsGrid(@builtin(vertex_index) vi: u32) -> GridOut {
  var o: GridOut;
  o.clip = fullscreenPosition(vi);
  o.ndc = o.clip.xy;
  return o;
}

struct GridFrag { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 }

// Coverage of the nearest line of spacing s, in device pixels.
fn lineCoverage(coord: vec2f, s: f32, halfWidth: f32) -> f32 {
  let c = coord / s;
  let w = max(fwidth(c), vec2f(1e-6));
  let g = abs(fract(c - 0.5) - 0.5) / w;
  let d = min(g.x, g.y);
  return clamp(halfWidth + 0.5 - d, 0.0, 1.0);
}

// 1 when a cell of spacing s is wide enough on screen to be worth drawing.
fn cellVisibility(coord: vec2f, s: f32) -> f32 {
  let w = fwidth(coord / s);
  let cell = 1.0 / max(max(w.x, w.y), 1e-6);
  return clamp((cell - 5.0) / 10.0, 0.0, 1.0);
}

@fragment fn fsGrid(v: GridOut) -> GridFrag {
  let a = unproject(vec3f(v.ndc, 0.0));
  let b = unproject(vec3f(v.ndc, 1.0));
  // info.x: 0 = xz (normal y), 1 = xy (normal z), 2 = yz (normal x).
  var n = 1; var ax = 0; var ay = 2;
  if (grid.info.x > 0.5 && grid.info.x < 1.5) { n = 2; ax = 0; ay = 1; }
  if (grid.info.x > 1.5) { n = 0; ax = 1; ay = 2; }
  let denom = b[n] - a[n];
  let t = select(-1.0, -a[n] / denom, abs(denom) > 1e-9);
  let hit = a + (b - a) * t;
  let coord = vec2f(hit[ax], hit[ay]);

  let dpr = frame.viewport.z;
  let halfWidth = max(0.5 * dpr, 0.5);
  let s0 = grid.info.y;
  let s1 = s0 * grid.info.z;
  let s2 = s1 * grid.info.z;
  let l0 = lineCoverage(coord, s0, halfWidth) * cellVisibility(coord, s0);
  let l1 = lineCoverage(coord, s1, halfWidth) * cellVisibility(coord, s1);
  let l2 = lineCoverage(coord, s2, halfWidth) * cellVisibility(coord, s2);

  let wc = max(fwidth(coord), vec2f(1e-6));
  let axisA = clamp(halfWidth * 1.5 + 0.5 - abs(coord.x) / wc.x, 0.0, 1.0);
  let axisB = clamp(halfWidth * 1.5 + 0.5 - abs(coord.y) / wc.y, 0.0, 1.0);

  // Layer minor, major and axis lines; later layers win where they cover.
  var color = grid.minor.rgb;
  var alpha = grid.minor.a * l0;
  let majorAlpha = grid.major.a * max(l1, l2);
  color = mix(color, grid.major.rgb, majorAlpha / max(alpha + majorAlpha, 1e-5));
  alpha = max(alpha, majorAlpha);
  let aa = grid.axisA.a * axisA;
  color = mix(color, grid.axisA.rgb, aa / max(alpha + aa, 1e-5));
  alpha = max(alpha, aa);
  let bb = grid.axisB.a * axisB;
  color = mix(color, grid.axisB.rgb, bb / max(alpha + bb, 1e-5));
  alpha = max(alpha, bb);

  // Fade at grazing angles and with distance; hide where the plane is behind us.
  let facing = abs(normalize(b - a)[n]);
  var fade = smoothstep(0.015, 0.2, facing);
  if (frame.cameraPos.w < 0.5) {
    let dist = length(hit - frame.cameraPos.xyz);
    fade = fade * (1.0 - smoothstep(0.4, 1.0, dist / (s2 * 40.0)));
  }
  let valid = select(0.0, 1.0, t > 0.0 && t < 1.0);
  alpha = alpha * fade * valid;

  let clipHit = frame.viewProj * vec4f(hit, 1.0);
  var out: GridFrag;
  out.color = vec4f(color, alpha);
  out.depth = clamp(clipHit.z / clipHit.w - 0.00003, 0.0, 1.0);
  return out;
}
`;
