/** Three-component vector helpers. All functions return fresh tuples. */
import type { Vec3 } from "./types.ts";

export const add = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
export const sub = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export const scale = (
  a: Vec3,
  s: number,
): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

/** Unit vector, or zero when the input has no length. */
export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const min = (a: Vec3, b: Vec3): Vec3 => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.min(a[2], b[2]),
];
export const max = (a: Vec3, b: Vec3): Vec3 => [
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
  Math.max(a[2], b[2]),
];
export const negate = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];
