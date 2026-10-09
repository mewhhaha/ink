/**
 * The 2D layer: sprites, tile maps and SDF text, drawn into the overlay
 * target (display-referred, premultiplied, depth tested against the scene)
 * with 2D lighting. Group 0 is the frame group; group 1 the layer (lighting
 * environment, lights, occluders, quads); group 2 one image.
 */
import { frameStruct } from "./frame_layout.ts";

export const MAX_LIGHTS_2D = 128;

export const spriteShader = /* wgsl */ `
${frameStruct}
@group(0) @binding(0) var<uniform> frame: Frame;

struct Env2 {
  ambient: vec4f,  // rgb summed ambient light (linear); w 1 when any 2D light exists
  counts: vec4f,   // x light count, y occluder present
  occ0: vec4f,     // xy world position of the occluder map's cell (0, 0), zw cell size
  occ1: vec4f,     // xy size of the occluder map in cells
}
struct Light2 {
  a: vec4f,  // xyz position, w kind: 1 lamp, 2 spotlight, 3 sun
  b: vec4f,  // rgb linear radiance, w radius
  c: vec4f,  // xy travel direction, z cos outer half angle, w cos inner
  d: vec4f,  // x falloff, y shadows, z height
}
struct Quad {
  m0: vec4f, m1: vec4f, m2: vec4f, m3: vec4f,  // unit square to world
  rect: vec4f,   // image rectangle, normalised, v down
  tint: vec4f,   // linear rgb and alpha
  p0: vec4f,     // x flags: 1 flip x, 2 flip y, 4 lit, 8 smooth, 16 has normal map; y outline width
  p1: vec4f,     // text: outline colour. tile map: size in tiles
}

@group(1) @binding(0) var<uniform> env: Env2;
@group(1) @binding(1) var<storage, read> lights: array<Light2>;
@group(1) @binding(2) var occluders: texture_2d<f32>;
@group(1) @binding(3) var<storage, read> quads: array<Quad>;

@group(2) @binding(0) var nearestSampler: sampler;
@group(2) @binding(1) var smoothSampler: sampler;
@group(2) @binding(2) var albedo: texture_2d<f32>;
@group(2) @binding(3) var normals: texture_2d<f32>;
@group(2) @binding(4) var tiles: texture_2d<u32>;
@group(2) @binding(5) var<storage, read> rects: array<vec4f>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) world: vec2f,
  @location(2) @interpolate(flat) inst: u32,
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let q = quads[ii];
  let c = corners[vi];
  let world = mat4x4f(q.m0, q.m1, q.m2, q.m3) * vec4f(c, 0.0, 1.0);
  var o: VOut;
  o.pos = frame.viewProj * world;
  o.uv = c;
  o.world = world.xy;
  o.inst = ii;
  return o;
}

fn solidAt(cell: vec2i) -> bool {
  let dims = vec2i(env.occ1.xy);
  if (cell.x < 0 || cell.y < 0 || cell.x >= dims.x || cell.y >= dims.y) { return false; }
  return textureLoad(occluders, cell, 0).r > 0.5;
}

// Whether the segment from p to l crosses a solid tile other than the ones at
// its ends: 1 when open, 0 when blocked. Solid tiles themselves are lit like
// walls (by distance and normal), and only cast shadows onto what is not.
fn shadowFactor(p: vec2f, l: vec2f) -> f32 {
  if (env.counts.y < 0.5) { return 1.0; }
  let cell = env.occ0.zw;
  let a = (p - env.occ0.xy) / cell;
  let b = (l - env.occ0.xy) / cell;
  let start = vec2i(floor(a));
  let to = vec2i(floor(b));
  if (solidAt(start)) { return 1.0; }
  let d = b - a;
  let steps = clamp(i32(ceil(length(d) * 3.0)), 1, 120);
  for (var i = 1; i < steps; i++) {
    let c = vec2i(floor(a + d * (f32(i) / f32(steps))));
    if (all(c == start) || all(c == to)) { continue; }
    if (solidAt(c)) { return 0.0; }
  }
  return 1.0;
}

// Light arriving at a point of a surface with normal n, 0 when unlit.
fn light2d(p: vec2f, n: vec3f, strength: f32) -> vec3f {
  var total = env.ambient.rgb;
  let count = i32(env.counts.x);
  for (var i = 0; i < count; i++) {
    let l = lights[i];
    let kind = l.a.w;
    var dir: vec3f;
    var amount = 1.0;
    if (kind > 2.5) {
      dir = normalize(vec3f(-l.c.xy, l.d.z));
    } else {
      let toLight = l.a.xy - p;
      let distance = length(toLight);
      let radius = l.b.w;
      if (distance >= radius) { continue; }
      amount = pow(clamp(1.0 - distance / radius, 0.0, 1.0), l.d.x);
      dir = normalize(vec3f(toLight, l.d.z));
      if (kind > 1.5) {
        let facing = dot(-normalize(toLight + vec2f(1e-5, 0.0)), l.c.xy);
        amount *= smoothstep(l.c.z, l.c.w, facing);
      }
      if (l.d.y > 0.5 && amount > 0.0) { amount *= shadowFactor(p, l.a.xy); }
    }
    let diffuse = mix(1.0, max(dot(n, dir), 0.0), strength);
    total += l.b.rgb * (amount * diffuse);
  }
  return total;
}

fn surfaceNormal(q: Quad, uv: vec2f) -> vec3f {
  var n = textureSampleLevel(normals, nearestSampler, uv, 0.0).xyz * 2.0 - 1.0;
  let f = u32(q.p0.x);
  if ((f & 1u) != 0u) { n.x = -n.x; }
  if ((f & 2u) != 0u) { n.y = -n.y; }
  let axis = normalize(q.m0.xy + vec2f(1e-6, 0.0));
  n = vec3f(n.x * axis.x - n.y * axis.y, n.x * axis.y + n.y * axis.x, n.z);
  return normalize(n);
}

fn shade(q: Quad, albedoColor: vec3f, uv: vec2f, world: vec2f) -> vec3f {
  let f = u32(q.p0.x);
  if ((f & 4u) == 0u || env.ambient.w < 0.5) { return albedoColor; }
  let hasNormals = (f & 16u) != 0u;
  var n = vec3f(0.0, 0.0, 1.0);
  if (hasNormals) { n = surfaceNormal(q, uv); }
  return albedoColor * light2d(world, n, select(0.0, 1.0, hasNormals));
}

// Keep nearest samples inside their frame so atlas neighbours never bleed in.
fn insideRect(uv: vec2f, rect: vec4f) -> vec2f {
  let size = vec2f(textureDimensions(albedo));
  let eps = 0.5 / size;
  return clamp(uv, rect.xy + eps * 0.01, rect.xy + rect.zw - eps * 0.01);
}

fn sampleAlbedo(q: Quad, uv: vec2f) -> vec4f {
  if ((u32(q.p0.x) & 8u) != 0u) {
    return textureSampleLevel(albedo, smoothSampler, uv, 0.0);
  }
  return textureSampleLevel(albedo, nearestSampler, uv, 0.0);
}

@fragment fn fsSprite(v: VOut) -> @location(0) vec4f {
  let q = quads[v.inst];
  let f = u32(q.p0.x);
  var u = v.uv.x;
  var w = v.uv.y;
  if ((f & 1u) != 0u) { u = 1.0 - u; }
  if ((f & 2u) != 0u) { w = 1.0 - w; }
  let uv = insideRect(q.rect.xy + vec2f(u, 1.0 - w) * q.rect.zw, q.rect);
  let texel = sampleAlbedo(q, uv);
  if (texel.a * q.tint.a < 0.004) { discard; }
  let lit = shade(q, texel.rgb * q.tint.rgb, uv, v.world);
  return vec4f(lit, texel.a * q.tint.a);
}

@fragment fn fsTile(v: VOut) -> @location(0) vec4f {
  let q = quads[v.inst];
  let size = q.p1.xy;
  let at = v.uv * size;
  let cell = vec2i(clamp(floor(at), vec2f(0.0), size - 1.0));
  let id = textureLoad(tiles, cell, 0).r;
  if (id == 0u) { discard; }
  let inside = at - vec2f(cell);
  let rect = rects[id];
  let uv = insideRect(rect.xy + vec2f(inside.x, 1.0 - inside.y) * rect.zw, rect);
  let texel = sampleAlbedo(q, uv);
  if (texel.a * q.tint.a < 0.004) { discard; }
  let lit = shade(q, texel.rgb * q.tint.rgb, uv, v.world);
  return vec4f(lit, texel.a * q.tint.a);
}

@fragment fn fsText(v: VOut) -> @location(0) vec4f {
  let q = quads[v.inst];
  let uv = q.rect.xy + vec2f(v.uv.x, 1.0 - v.uv.y) * q.rect.zw;
  let d = textureSample(albedo, smoothSampler, uv).r;
  let w = max(fwidth(d) * 0.75, 0.002);
  let fill = smoothstep(0.5 - w, 0.5 + w, d);
  let reach = q.p0.y;
  var rgb = q.tint.rgb;
  var a = fill;
  if (reach > 0.0) {
    let outer = smoothstep(0.5 - reach - w, 0.5 - reach + w, d);
    rgb = mix(q.p1.rgb, q.tint.rgb, fill);
    a = max(outer * q.p1.a, fill);
  }
  a *= q.tint.a;
  if (a < 0.004) { discard; }
  return vec4f(rgb, a);
}
`;
