import { clamp, finite_number } from "./scalar.ts";
import { type Vec3, vec3, vec3_normalize } from "./vector.ts";

declare const quat_brand: unique symbol;

export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly [quat_brand]: true;
}

function normalized_quat(x: number, y: number, z: number, w: number): Quat {
  finite_number(x, "quat.x");
  finite_number(y, "quat.y");
  finite_number(z, "quat.z");
  finite_number(w, "quat.w");
  const length = Math.hypot(x, y, z, w);
  if (length === 0) {
    throw new Error(
      `cannot normalize zero quaternion (${x}, ${y}, ${z}, ${w})`,
    );
  }
  return Object.freeze({
    x: x / length,
    y: y / length,
    z: z / length,
    w: w / length,
  }) as Quat;
}

export function quat(x: number, y: number, z: number, w: number): Quat {
  return normalized_quat(x, y, z, w);
}

export function quat_identity(): Quat {
  return Object.freeze({ x: 0, y: 0, z: 0, w: 1 }) as Quat;
}

export function quat_from_axis_angle(axis: Vec3, radians: number): Quat {
  finite_number(radians, "rotation radians");
  const normalized_axis = vec3_normalize(axis);
  const half_angle = radians / 2;
  const sine = Math.sin(half_angle);
  return normalized_quat(
    normalized_axis.x * sine,
    normalized_axis.y * sine,
    normalized_axis.z * sine,
    Math.cos(half_angle),
  );
}

export function quat_multiply(left: Quat, right: Quat): Quat {
  return normalized_quat(
    left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
    left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
    left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
    left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
  );
}

export function quat_inverse(rotation: Quat): Quat {
  return Object.freeze({
    x: -rotation.x,
    y: -rotation.y,
    z: -rotation.z,
    w: rotation.w,
  }) as Quat;
}

export function quat_rotate_vec3(rotation: Quat, vector: Vec3): Vec3 {
  const tx = 2 * (rotation.y * vector.z - rotation.z * vector.y);
  const ty = 2 * (rotation.z * vector.x - rotation.x * vector.z);
  const tz = 2 * (rotation.x * vector.y - rotation.y * vector.x);
  return vec3(
    vector.x + rotation.w * tx + rotation.y * tz - rotation.z * ty,
    vector.y + rotation.w * ty + rotation.z * tx - rotation.x * tz,
    vector.z + rotation.w * tz + rotation.x * ty - rotation.y * tx,
  );
}

export function quat_slerp(start: Quat, finish: Quat, amount: number): Quat {
  finite_number(amount, "slerp amount");
  let finish_x = finish.x;
  let finish_y = finish.y;
  let finish_z = finish.z;
  let finish_w = finish.w;
  let cosine = start.x * finish_x + start.y * finish_y + start.z * finish_z +
    start.w * finish_w;
  if (cosine < 0) {
    cosine = -cosine;
    finish_x = -finish_x;
    finish_y = -finish_y;
    finish_z = -finish_z;
    finish_w = -finish_w;
  }
  if (cosine > 0.9995) {
    return normalized_quat(
      start.x + amount * (finish_x - start.x),
      start.y + amount * (finish_y - start.y),
      start.z + amount * (finish_z - start.z),
      start.w + amount * (finish_w - start.w),
    );
  }
  const angle = Math.acos(clamp(cosine, -1, 1));
  const sine = Math.sin(angle);
  const start_weight = Math.sin((1 - amount) * angle) / sine;
  const finish_weight = Math.sin(amount * angle) / sine;
  return normalized_quat(
    start.x * start_weight + finish_x * finish_weight,
    start.y * start_weight + finish_y * finish_weight,
    start.z * start_weight + finish_z * finish_weight,
    start.w * start_weight + finish_w * finish_weight,
  );
}
