import { lightStruct } from "./common.ts";
import { CLUSTER_CAPACITY, frameStruct } from "./frame_layout.ts";

/** One invocation owns a cluster and writes ascending light ids. Stable order
 * keeps still captures deterministic; overflowing clusters use the full loop. */
export const clustersWgsl = /* wgsl */ `
${frameStruct}
${lightStruct}
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> lights: array<Light>;
@group(0) @binding(2) var<storage, read_write> clusters: array<u32>;

fn viewPoint(ndc: vec2f, depth: f32) -> vec3f {
  let a = frame.view * frame.invViewProj * vec4f(ndc, 0.0, 1.0);
  let b = frame.view * frame.invViewProj * vec4f(ndc, 1.0, 1.0);
  let p = a.xyz / a.w;
  let q = b.xyz / b.w;
  return mix(p, q, (-depth - p.z) / (q.z - p.z));
}

@compute @workgroup_size(64)
fn cull(@builtin(global_invocation_id) invocation: vec3u) {
  let grid = vec3u(frame.clusterGrid.xyz);
  let id = invocation.x;
  if (id >= grid.x * grid.y * grid.z) { return; }
  let cell = vec3u(id % grid.x, (id / grid.x) % grid.y, id / (grid.x * grid.y));
  let slices = vec2f(f32(cell.z), f32(cell.z + 1u)) / f32(grid.z);
  let near = frame.clusterDepth.x;
  let far = frame.clusterDepth.y;
  var depths = near * exp(slices * frame.clusterDepth.z);
  if (frame.cameraPos.w > 0.5) { depths = mix(vec2f(near), vec2f(far), slices); }
  let lo = vec2f(cell.xy) / vec2f(grid.xy);
  let hi = vec2f(cell.xy + vec2u(1u)) / vec2f(grid.xy);
  var minimum = vec3f(1e30);
  var maximum = vec3f(-1e30);
  for (var z = 0u; z < 2u; z++) {
    for (var y = 0u; y < 2u; y++) {
      for (var x = 0u; x < 2u; x++) {
        let uv = vec2f(select(lo.x, hi.x, x == 1u), select(lo.y, hi.y, y == 1u));
        let p = viewPoint(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), depths[z]);
        minimum = min(minimum, p);
        maximum = max(maximum, p);
      }
    }
  }
  // Conservative padding for projection roundoff and MSAA boundary samples.
  let padding = 0.001 * (1.0 + depths.y);
  minimum -= vec3f(padding);
  maximum += vec3f(padding);
  let base = id * ${CLUSTER_CAPACITY + 1}u;
  var count = 0u;
  for (var i = 0u; i < u32(frame.params.y); i++) {
    let light = lights[i];
    var visible = light.posType.w < 0.5 || light.colorRange.w <= 0.0;
    if (!visible) {
      // The range sphere conservatively bounds both point and spot lights.
      let center = (frame.view * vec4f(light.posType.xyz, 1.0)).xyz;
      let closest = clamp(center, minimum, maximum);
      let delta = closest - center;
      visible = dot(delta, delta) <= light.colorRange.w * light.colorRange.w;
    }
    if (visible) {
      if (count == ${CLUSTER_CAPACITY}u) { count++; break; }
      clusters[base + 1u + count] = i;
      count++;
    }
  }
  clusters[base] = count;
}
`;

/** Same depth partition as the compute pass, evaluated at the shaded sample. */
export const clusterLookupWgsl = /* wgsl */ `
fn clusterOffset(world: vec3f, frag: vec2f) -> u32 {
  let grid = vec3u(frame.clusterGrid.xyz);
  let depth = max(frame.clusterDepth.x, dot(world - frame.cameraPos.xyz, frame.cameraDir.xyz));
  var z = log(depth / frame.clusterDepth.x) / frame.clusterDepth.z;
  if (frame.cameraPos.w > 0.5) {
    z = (depth - frame.clusterDepth.x) / (frame.clusterDepth.y - frame.clusterDepth.x);
  }
  let xy = min(vec2u(max(frag, vec2f(0.0)) / frame.viewport.xy * vec2f(grid.xy)), grid.xy - vec2u(1u));
  let zi = min(u32(max(z, 0.0) * f32(grid.z)), grid.z - 1u);
  return ((zi * grid.y + xy.y) * grid.x + xy.x) * ${CLUSTER_CAPACITY + 1}u;
}
`;
