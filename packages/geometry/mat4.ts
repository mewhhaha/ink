/**
 * 4×4 matrices, column-major in a `Float32Array(16)`: element (row r, column c)
 * is at index `c * 4 + r`. Projections target WebGPU clip space (depth 0..1,
 * right-handed view space looking down -Z).
 */
import type { Mat4, Quat, Vec3 } from "./types.ts";

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] =
    m[5] =
    m[10] =
    m[15] =
      1;
  return m;
}

/** `a * b`: applies `b` first, then `a`. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function transpose(m: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) out[r * 4 + c] = m[c * 4 + r];
  }
  return out;
}

/** General inverse; returns the identity for singular matrices. */
export function invert(m: Mat4): Mat4 {
  const a = Array.from(m, Number);
  const inv = new Array<number>(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] +
    a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] -
    a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] +
    a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] -
    a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] -
    a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] +
    a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] -
    a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] +
    a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] +
    a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] -
    a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] +
    a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] -
    a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] -
    a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] +
    a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] -
    a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] +
    a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (Math.abs(det) < 1e-30) return identity();
  const out = new Float32Array(16);
  for (let i = 0; i < 16; i++) out[i] = inv[i] / det;
  return out;
}

/** Perspective projection, vertical field of view in radians, depth 0..1. */
export function perspective(
  fovYRadians: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const f = 1 / Math.tan(fovYRadians / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (far * near) / (near - far);
  return m;
}

/** Orthographic projection of the box between the planes, depth 0..1. */
export function orthographic(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): Mat4 {
  const m = new Float32Array(16);
  m[0] = 2 / (right - left);
  m[5] = 2 / (top - bottom);
  m[10] = 1 / (near - far);
  m[12] = -(right + left) / (right - left);
  m[13] = -(top + bottom) / (top - bottom);
  m[14] = near / (near - far);
  m[15] = 1;
  return m;
}

/** View matrix of a camera at `eye` looking at `target`. */
export function lookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Mat4 {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  const zl = Math.hypot(zx, zy, zz) || 1;
  zx /= zl;
  zy /= zl;
  zz /= zl;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  let xl = Math.hypot(xx, xy, xz);
  if (xl < 1e-8) {
    // Looking straight along up: pick another helper axis.
    const hx = Math.abs(zx) < 0.9 ? 1 : 0;
    const hz = 1 - hx;
    xx = 0 * zz - hz * zy;
    xy = hz * zx - hx * zz;
    xz = hx * zy - 0 * zx;
    xl = Math.hypot(xx, xy, xz);
  }
  xx /= xl;
  xy /= xl;
  xz /= xl;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx;
  m[4] = xy;
  m[8] = xz;
  m[1] = yx;
  m[5] = yy;
  m[9] = yz;
  m[2] = zx;
  m[6] = zy;
  m[10] = zz;
  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  m[15] = 1;
  return m;
}

/** Translation * rotation * scale. */
export function compose(t: Vec3, r: Quat, s: Vec3): Mat4 {
  const [x, y, z, w] = r;
  const m = new Float32Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * s[0];
  m[1] = 2 * (x * y + w * z) * s[0];
  m[2] = 2 * (x * z - w * y) * s[0];
  m[4] = 2 * (x * y - w * z) * s[1];
  m[5] = (1 - 2 * (x * x + z * z)) * s[1];
  m[6] = 2 * (y * z + w * x) * s[1];
  m[8] = 2 * (x * z + w * y) * s[2];
  m[9] = 2 * (y * z - w * x) * s[2];
  m[10] = (1 - 2 * (x * x + y * y)) * s[2];
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  m[15] = 1;
  return m;
}

/** Split an affine matrix into translation, rotation and scale. A mirrored
 * matrix reports a negative X scale. */
export function decompose(m: Mat4): { t: Vec3; r: Quat; s: Vec3 } {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[4] * (m[1] * m[10] - m[2] * m[9]) +
    m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sx = -sx;
  const ix = sx !== 0 ? 1 / sx : 0;
  const iy = sy !== 0 ? 1 / sy : 0;
  const iz = sz !== 0 ? 1 / sz : 0;
  const r = fromRotationColumns(
    [m[0] * ix, m[1] * ix, m[2] * ix],
    [m[4] * iy, m[5] * iy, m[6] * iy],
    [m[8] * iz, m[9] * iz, m[10] * iz],
  );
  return { t: [m[12], m[13], m[14]], r, s: [sx, sy, sz] };
}

function fromRotationColumns(x: Vec3, y: Vec3, z: Vec3): Quat {
  const trace = x[0] + y[1] + z[2];
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(y[2] - z[1]) * s, (z[0] - x[2]) * s, (x[1] - y[0]) * s, 0.25 / s];
  } else if (x[0] > y[1] && x[0] > z[2]) {
    const s = 2 * Math.sqrt(1 + x[0] - y[1] - z[2]);
    q = [0.25 * s, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s];
  } else if (y[1] > z[2]) {
    const s = 2 * Math.sqrt(1 + y[1] - x[0] - z[2]);
    q = [(y[0] + x[1]) / s, 0.25 * s, (z[1] + y[2]) / s, (z[0] - x[2]) / s];
  } else {
    const s = 2 * Math.sqrt(1 + z[2] - x[0] - y[1]);
    q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, 0.25 * s, (x[1] - y[0]) / s];
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Transform a point (w = 1), dividing by w for projective matrices. */
export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return w !== 1 && w !== 0 ? [x / w, y / w, z / w] : [x, y, z];
}

/** Transform a direction (w = 0): no translation, no normalization. */
export function transformDirection(m: Mat4, d: Vec3): Vec3 {
  return [
    m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
    m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
    m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
  ];
}

/** Inverse transpose, with the translation removed: transforms normals. */
export function normalMatrix(m: Mat4): Mat4 {
  const linear = new Float32Array(m);
  linear[12] = linear[13] = linear[14] = 0;
  linear[3] = linear[7] = linear[11] = 0;
  linear[15] = 1;
  return transpose(invert(linear));
}
