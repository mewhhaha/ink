/**
 * Quaternions `[x, y, z, w]`.
 *
 * Euler angles are in DEGREES as `[x, y, z]` = `[pitch, yaw, roll]` and compose
 * in YXZ order: `q = qYaw * qPitch * qRoll`, i.e. roll about local Z first, then
 * pitch about X, then yaw about the world Y axis. That is what an inspector
 * wants: yaw turns the object on the ground plane, pitch tilts it up and down.
 */
import type { Quat, Vec3 } from "./types.ts";

const DEG = Math.PI / 180;

export const identity = (): Quat => [0, 0, 0, 1];

export function multiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function normalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l > 1e-12 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1];
}

export const conjugate = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/** Rotate a vector by a unit quaternion. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

export function fromAxisAngle(axis: Vec3, radians: number): Quat {
  const l = Math.hypot(axis[0], axis[1], axis[2]);
  if (l < 1e-12) return [0, 0, 0, 1];
  const s = Math.sin(radians / 2) / l;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(radians / 2)];
}

/** `[pitch, yaw, roll]` in degrees, composed YXZ (see the file comment). */
export function fromEuler(degrees: Vec3): Quat {
  const qy = fromAxisAngle([0, 1, 0], degrees[1] * DEG);
  const qx = fromAxisAngle([1, 0, 0], degrees[0] * DEG);
  const qz = fromAxisAngle([0, 0, 1], degrees[2] * DEG);
  return normalize(multiply(multiply(qy, qx), qz));
}

/** Inverse of `fromEuler`: `[pitch, yaw, roll]` in degrees. Pitch is in
 * [-90, 90]; at the poles roll is folded into yaw. */
export function toEuler(q: Quat): Vec3 {
  const [x, y, z, w] = normalize(q);
  const m13 = 2 * (x * z + w * y);
  const m33 = 1 - 2 * (x * x + y * y);
  const m23 = 2 * (y * z - w * x);
  const m21 = 2 * (x * y + w * z);
  const m22 = 1 - 2 * (x * x + z * z);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -m23)));
  if (Math.abs(m23) < 0.9999999) {
    return [
      pitch / DEG,
      Math.atan2(m13, m33) / DEG,
      Math.atan2(m21, m22) / DEG,
    ];
  }
  const m31 = 2 * (x * z - w * y);
  const m11 = 1 - 2 * (y * y + z * z);
  return [pitch / DEG, Math.atan2(-m31, m11) / DEG, 0];
}

/** Shortest-arc spherical interpolation. */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0 = 1 - t;
  let s1 = t;
  if (cos < 0.9995) {
    const angle = Math.acos(cos);
    const sin = Math.sin(angle);
    s0 = Math.sin((1 - t) * angle) / sin;
    s1 = Math.sin(t * angle) / sin;
  }
  return normalize([
    a[0] * s0 + bx * s1,
    a[1] * s0 + by * s1,
    a[2] * s0 + bz * s1,
    a[3] * s0 + bw * s1,
  ]);
}

/** Rotation whose local -Z axis points along `forward` with local +Y as close
 * to `up` as possible (the camera/light convention). */
export function lookRotation(forward: Vec3, up: Vec3 = [0, 1, 0]): Quat {
  const fl = Math.hypot(forward[0], forward[1], forward[2]);
  if (fl < 1e-12) return [0, 0, 0, 1];
  // z axis of the basis points backwards.
  const z: Vec3 = [-forward[0] / fl, -forward[1] / fl, -forward[2] / fl];
  let x: Vec3 = [
    up[1] * z[2] - up[2] * z[1],
    up[2] * z[0] - up[0] * z[2],
    up[0] * z[1] - up[1] * z[0],
  ];
  let xl = Math.hypot(x[0], x[1], x[2]);
  if (xl < 1e-8) {
    // Forward is parallel to up: pick any perpendicular helper.
    const helper: Vec3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    x = [
      helper[1] * z[2] - helper[2] * z[1],
      helper[2] * z[0] - helper[0] * z[2],
      helper[0] * z[1] - helper[1] * z[0],
    ];
    xl = Math.hypot(x[0], x[1], x[2]);
  }
  x = [x[0] / xl, x[1] / xl, x[2] / xl];
  const y: Vec3 = [
    z[1] * x[2] - z[2] * x[1],
    z[2] * x[0] - z[0] * x[2],
    z[0] * x[1] - z[1] * x[0],
  ];
  return fromBasis(x, y, z);
}

/** Quaternion of the rotation matrix with the given orthonormal columns. */
export function fromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
  const m11 = x[0], m12 = y[0], m13 = z[0];
  const m21 = x[1], m22 = y[1], m23 = z[1];
  const m31 = x[2], m32 = y[2], m33 = z[2];
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return normalize([
      (m32 - m23) * s,
      (m13 - m31) * s,
      (m21 - m12) * s,
      0.25 / s,
    ]);
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return normalize([
      0.25 * s,
      (m12 + m21) / s,
      (m13 + m31) / s,
      (m32 - m23) / s,
    ]);
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return normalize([
      (m12 + m21) / s,
      0.25 * s,
      (m23 + m32) / s,
      (m13 - m31) / s,
    ]);
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return normalize([
    (m13 + m31) / s,
    (m23 + m32) / s,
    0.25 * s,
    (m21 - m12) / s,
  ]);
}
