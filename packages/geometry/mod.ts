/**
 * @ink/geometry: vector, matrix and quaternion math, rays, primitive meshes
 * and convex brushes. Pure TypeScript with no DOM dependency.
 *
 * Conventions: right-handed, Y up, cameras look down local -Z, WebGPU clip
 * depth 0..1, column-major matrices.
 */
export type {
  Aabb,
  Mat4,
  Plane,
  Quat,
  Ray,
  Vec2,
  Vec3,
  Vec4,
} from "./types.ts";
export * as vec3 from "./vec3.ts";
export * as quat from "./quat.ts";
export * as mat4 from "./mat4.ts";
export * from "./ray.ts";
export {
  builtinMesh,
  capsuleMesh,
  computeNormals,
  coneMesh,
  cubeMesh,
  cylinderMesh,
  meshBounds,
  type MeshData,
  planeMesh,
  sphereMesh,
} from "./mesh.ts";
export * from "./brush.ts";
export * as noise from "./noise.ts";
export { blueNoise, builtinTexture, type Image } from "./noise.ts";
