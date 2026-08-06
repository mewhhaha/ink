import { type Mat4, mat4, mat4_inverse, mat4_multiply } from "./matrix.ts";
import { type Quat, quat, quat_identity, quat_slerp } from "./quaternion.ts";
import { DEFAULT_EPSILON, finite_number } from "./scalar.ts";
import {
  type Vec3,
  vec3,
  vec3_cross,
  vec3_dot,
  vec3_length,
  vec3_lerp,
  vec3_scale,
} from "./vector.ts";

export interface Transform {
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

export type TransformDecompositionResult =
  | { readonly ok: true; readonly value: Transform }
  | {
    readonly ok: false;
    readonly reason: "not_affine" | "singular_scale" | "sheared";
    readonly evidence: number;
  };

export function transform(
  position: Vec3,
  rotation: Quat,
  scale: Vec3,
): Transform {
  return Object.freeze({ position, rotation, scale });
}

export function transform_identity(): Transform {
  return transform(vec3(0, 0, 0), quat_identity(), vec3(1, 1, 1));
}

export function transform_to_mat4(value: Transform): Mat4 {
  const { x, y, z, w } = value.rotation;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return mat4([
    (1 - 2 * (yy + zz)) * value.scale.x,
    2 * (xy + wz) * value.scale.x,
    2 * (xz - wy) * value.scale.x,
    0,
    2 * (xy - wz) * value.scale.y,
    (1 - 2 * (xx + zz)) * value.scale.y,
    2 * (yz + wx) * value.scale.y,
    0,
    2 * (xz + wy) * value.scale.z,
    2 * (yz - wx) * value.scale.z,
    (1 - 2 * (xx + yy)) * value.scale.z,
    0,
    value.position.x,
    value.position.y,
    value.position.z,
    1,
  ]);
}

function quat_from_rotation_columns(
  x_axis: Vec3,
  y_axis: Vec3,
  z_axis: Vec3,
): Quat {
  const trace = x_axis.x + y_axis.y + z_axis.z;
  if (trace > 0) {
    const root = Math.sqrt(trace + 1) * 2;
    return quat(
      (y_axis.z - z_axis.y) / root,
      (z_axis.x - x_axis.z) / root,
      (x_axis.y - y_axis.x) / root,
      root / 4,
    );
  }
  if (x_axis.x > y_axis.y && x_axis.x > z_axis.z) {
    const root = Math.sqrt(1 + x_axis.x - y_axis.y - z_axis.z) * 2;
    return quat(
      root / 4,
      (y_axis.x + x_axis.y) / root,
      (z_axis.x + x_axis.z) / root,
      (y_axis.z - z_axis.y) / root,
    );
  }
  if (y_axis.y > z_axis.z) {
    const root = Math.sqrt(1 + y_axis.y - x_axis.x - z_axis.z) * 2;
    return quat(
      (y_axis.x + x_axis.y) / root,
      root / 4,
      (z_axis.y + y_axis.z) / root,
      (z_axis.x - x_axis.z) / root,
    );
  }
  const root = Math.sqrt(1 + z_axis.z - x_axis.x - y_axis.y) * 2;
  return quat(
    (z_axis.x + x_axis.z) / root,
    (z_axis.y + y_axis.z) / root,
    root / 4,
    (x_axis.y - y_axis.x) / root,
  );
}

export function mat4_decompose(
  matrix: Mat4,
  epsilon = DEFAULT_EPSILON,
): TransformDecompositionResult {
  finite_number(epsilon, "decomposition epsilon");
  if (epsilon < 0) {
    throw new Error(
      `decomposition epsilon must be non-negative, received ${epsilon}`,
    );
  }
  const affine_error = Math.max(
    Math.abs(matrix[3]),
    Math.abs(matrix[7]),
    Math.abs(matrix[11]),
    Math.abs(matrix[15] - 1),
  );
  if (affine_error > epsilon) {
    return { ok: false, reason: "not_affine", evidence: affine_error };
  }
  let x_axis = vec3(matrix[0], matrix[1], matrix[2]);
  const y_axis = vec3(matrix[4], matrix[5], matrix[6]);
  const z_axis = vec3(matrix[8], matrix[9], matrix[10]);
  let scale_x = vec3_length(x_axis);
  const scale_y = vec3_length(y_axis);
  const scale_z = vec3_length(z_axis);
  const minimum_scale = Math.min(scale_x, scale_y, scale_z);
  if (minimum_scale <= epsilon) {
    return { ok: false, reason: "singular_scale", evidence: minimum_scale };
  }
  x_axis = vec3_scale(x_axis, 1 / scale_x);
  const normalized_y = vec3_scale(y_axis, 1 / scale_y);
  const normalized_z = vec3_scale(z_axis, 1 / scale_z);
  const shear = Math.max(
    Math.abs(vec3_dot(x_axis, normalized_y)),
    Math.abs(vec3_dot(x_axis, normalized_z)),
    Math.abs(vec3_dot(normalized_y, normalized_z)),
  );
  if (shear > epsilon) return { ok: false, reason: "sheared", evidence: shear };
  if (vec3_dot(vec3_cross(x_axis, normalized_y), normalized_z) < 0) {
    scale_x = -scale_x;
    x_axis = vec3_scale(x_axis, -1);
  }
  return {
    ok: true,
    value: transform(
      vec3(matrix[12], matrix[13], matrix[14]),
      quat_from_rotation_columns(x_axis, normalized_y, normalized_z),
      vec3(scale_x, scale_y, scale_z),
    ),
  };
}

export function transform_compose(
  parent: Transform,
  local: Transform,
): TransformDecompositionResult {
  return mat4_decompose(
    mat4_multiply(transform_to_mat4(parent), transform_to_mat4(local)),
  );
}

export function transform_inverse(
  value: Transform,
): TransformDecompositionResult {
  const inverse = mat4_inverse(transform_to_mat4(value));
  if (!inverse.ok) {
    return { ok: false, reason: "singular_scale", evidence: inverse.pivot };
  }
  return mat4_decompose(inverse.value);
}

export function transform_lerp(
  start: Transform,
  finish: Transform,
  amount: number,
): Transform {
  return transform(
    vec3_lerp(start.position, finish.position, amount),
    quat_slerp(start.rotation, finish.rotation, amount),
    vec3_lerp(start.scale, finish.scale, amount),
  );
}
