/**
 * Shared value types. Conventions: right-handed, Y up, cameras look down their
 * local -Z axis, WebGPU clip depth 0..1. Matrices are column-major
 * `Float32Array(16)` so they upload to WGSL `mat4x4<f32>` unchanged.
 */
export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];
/** Unit quaternion `[x, y, z, w]`. */
export type Quat = [number, number, number, number];
export type Mat4 = Float32Array;

/** Axis-aligned box. */
export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/** A half-line; `direction` is normalized. */
export interface Ray {
  origin: Vec3;
  direction: Vec3;
}

/** Plane `[nx, ny, nz, d]` with points on it satisfying `n · p = d`. */
export type Plane = Vec4;
