const shared = /* wgsl */ `
struct Camera {
  viewProjection: mat4x4f,
  view: mat4x4f,
  right: vec4f,
  up: vec4f,
};
struct Particle {
  position: vec4f,
  color: vec4f,
  style: vec4f,
};
@group(0) @binding(0) var<uniform> camera: Camera;
`;

export const particleCompute = shared + /* wgsl */ `
struct Emitter {
  matrix: mat4x4f,
  velocityRadius: vec4f,
  spread: vec4f,
  gravityLife: vec4f,
  color: vec4f,
  endColor: vec4f,
  settings: vec4f,
  emission: vec4f,
  ids: vec4u,
};
@group(0) @binding(1) var<storage, read> emitters: array<Emitter>;
@group(0) @binding(2) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(3) var<storage, read_write> order: array<u32>;
// Keys only: the 2048-entry sort fits the baseline 16 KiB workgroup limit.
var<workgroup> keys: array<vec2f, 2048>;
fn hash(v: u32) -> u32 {
  var x = v;
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  return x ^ (x >> 16u);
}
fn random(seed: u32, channel: u32) -> f32 {
  return f32(hash(seed ^ (channel * 0x9e3779b9u)) >> 8u) / 16777216.0;
}
fn random3(seed: u32, channel: u32) -> vec3f {
  return vec3f(random(seed, channel), random(seed, channel + 1u), random(seed, channel + 2u)) * 2.0 - 1.0;
}
@compute @workgroup_size(128)
fn simulate(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) thread: u32) {
  let e = emitters[group.x];
  let base = group.x * 2048u;
  for (var i = thread; i < 2048u; i += 128u) {
    var depth = -1e20;
    if (i < e.ids.y) {
      let sequence = e.emission.z + f32(i);
      var age = e.emission.y;
      if (e.emission.x > 0.0) { age -= sequence / e.emission.x; }
      let alive = age >= 0.0 && age < e.gravityLife.w && sequence >= 0.0;
      let seed = hash(u32(max(0.0, sequence)) ^ e.ids.x);
      let velocity = e.velocityRadius.xyz + random3(seed, 1u) * e.spread.xyz;
      let local = random3(seed, 4u) * e.velocityRadius.w + velocity * age + 0.5 * e.gravityLife.xyz * age * age;
      let world = (e.matrix * vec4f(local, 1.0)).xyz;
      let t = clamp(age / e.gravityLife.w, 0.0, 1.0);
      var color = mix(e.color, e.endColor, t);
      color = vec4f(color.rgb * e.settings.z, select(0.0, color.a, alive));
      let size = max(0.0, mix(e.settings.x, e.settings.y, t));
      var angle = random(seed, 7u) * 6.283185;
      if (e.settings.w > 0.5) {
        let v = (e.matrix * vec4f(velocity + e.gravityLife.xyz * age, 0.0)).xyz;
        angle = atan2(dot(v, camera.up.xyz), dot(v, camera.right.xyz)) - 1.570796;
      }
      particles[base + i] = Particle(vec4f(world, size), color, vec4f(angle, e.settings.w, 0.0, 0.0));
      if (alive) { depth = -(camera.view * vec4f(world, 1.0)).z; }
    }
    keys[i] = vec2f(depth, f32(base + i));
  }
  workgroupBarrier();
  // Stable bitonic depth sort. A tick, seed and camera always produce the same
  // order, including particles at identical depths, on every invocation.
  for (var k = 2u; k <= 2048u; k *= 2u) {
    for (var j = k / 2u; j > 0u; j /= 2u) {
      for (var i = thread; i < 2048u; i += 128u) {
        let other = i ^ j;
        if (other > i) {
          let a = keys[i]; let b = keys[other];
          let after = a.x < b.x || (a.x == b.x && a.y > b.y);
          if (after == ((i & k) == 0u)) { keys[i] = b; keys[other] = a; }
        }
      }
      workgroupBarrier();
    }
  }
  for (var i = thread; i < e.ids.y; i += 128u) { order[base + i] = u32(keys[i].y); }
}
`;

export const particleRender = shared + /* wgsl */ `
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read> order: array<u32>;
@group(1) @binding(0) var texSampler: sampler;
@group(1) @binding(1) var tex: texture_2d<f32>;
struct Vertex {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};
@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Vertex {
  let p = particles[order[instance]];
  let corners = array<vec2f, 6>(vec2f(-1,-1), vec2f(1,-1), vec2f(-1,1), vec2f(-1,1), vec2f(1,-1), vec2f(1,1));
  let corner = corners[vertex];
  let shape = select(vec2f(1.0), vec2f(0.3, 2.5), p.style.y > 0.5);
  let local = corner * shape * p.position.w * 0.5;
  let c = cos(p.style.x); let s = sin(p.style.x);
  let rotated = vec2f(local.x * c - local.y * s, local.x * s + local.y * c);
  let world = p.position.xyz + camera.right.xyz * rotated.x + camera.up.xyz * rotated.y;
  return Vertex(camera.viewProjection * vec4f(world, 1.0), corner * 0.5 + 0.5, p.color);
}
@fragment fn fs(v: Vertex) -> @location(0) vec4f {
  let texel = textureSample(tex, texSampler, v.uv);
  let radius = length(v.uv * 2.0 - 1.0);
  let edge = 1.0 - smoothstep(0.15, 1.0, radius);
  let alpha = v.color.a * texel.a * edge;
  if (alpha <= 0.001) { discard; }
  return vec4f(v.color.rgb * texel.rgb, alpha);
}
`;
