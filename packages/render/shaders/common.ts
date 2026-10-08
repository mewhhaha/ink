/** WGSL shared by every pipeline that binds the frame group (group 0): the
 * frame uniform, the light buffer and the reserved extension resources. See
 * the "Extension points" table in README.md. */
import { frameStruct, MAX_CASCADES } from "./frame_layout.ts";
import { blueNoiseWgsl } from "./noise.ts";

export { MAX_LIGHTS } from "./frame_layout.ts";

export const common = /* wgsl */ `
const PI: f32 = 3.14159265359;
const MAX_CASCADES: u32 = ${MAX_CASCADES}u;

struct Light {
  posType: vec4f,    // xyz position, w kind: 0 directional, 1 point, 2 spot
  colorRange: vec4f, // rgb linear radiance (colour * intensity), w range
  dirCone: vec4f,    // xyz direction the light travels, w cos(outer half angle)
  extra: vec4f,      // x cos(inner half angle), y softness, z shadow slot (-1: none), w reserved
}

${frameStruct}

@group(0) @binding(0) var<uniform> frame: Frame;
// Sun shadow: depth array, one layer per cascade.
@group(0) @binding(1) var sunShadowMap: texture_depth_2d_array;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
// Spot shadow atlas and point shadow cube array.
@group(0) @binding(3) var spotShadowAtlas: texture_depth_2d;
@group(0) @binding(4) var pointShadowCubes: texture_depth_cube_array;
// Screen-space ambient occlusion at half resolution: r visibility (1 = open),
// g view depth.
@group(0) @binding(5) var aoTexture: texture_2d<f32>;
@group(0) @binding(6) var linearSampler: sampler;
// Image-based lighting (reserved): environment cube, prefiltered specular
// cube with mips, split-sum BRDF lookup (x: scale, y: bias).
@group(0) @binding(7) var environmentCube: texture_cube<f32>;
@group(0) @binding(8) var specularCube: texture_cube<f32>;
@group(0) @binding(9) var brdfLut: texture_2d<f32>;
${blueNoiseWgsl(0, 10)}
@group(0) @binding(11) var<storage, read> lights: array<Light>;
// Records of the local-light shadows (see shaders/shadows.ts).
@group(0) @binding(12) var<storage, read> shadowMatrices: array<mat4x4f>;
// The point shadow cubes as a plain array of faces (6 per cube), for
// blocker search with textureLoad.
@group(0) @binding(13) var pointShadowFaces: texture_depth_2d_array;

fn fullscreenPosition(vi: u32) -> vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn unproject(ndc: vec3f) -> vec3f {
  let p = frame.invViewProj * vec4f(ndc, 1.0);
  return p.xyz / p.w;
}
`;
