/** Rays and intersection tests. Every test returns the distance `t` along the
 * ray (`origin + direction * t`) or `null` when there is no hit in front. */
import { transformPoint } from "./mat4.ts";
import type { Aabb, Mat4, Plane, Ray, Vec2, Vec3 } from "./types.ts";
import * as vec3 from "./vec3.ts";

/** The world-space ray through a normalized-device-coordinate position
 * (`x`, `y` in -1..1, +y up) for either projection type. */
export function rayFromNdc(inverseViewProjection: Mat4, ndc: Vec2): Ray {
  const near = transformPoint(inverseViewProjection, [ndc[0], ndc[1], 0]);
  const far = transformPoint(inverseViewProjection, [ndc[0], ndc[1], 1]);
  return { origin: near, direction: vec3.normalize(vec3.sub(far, near)) };
}

export const rayAt = (ray: Ray, t: number): Vec3 =>
  vec3.add(ray.origin, vec3.scale(ray.direction, t));

export function intersectPlane(ray: Ray, plane: Plane): number | null {
  const n: Vec3 = [plane[0], plane[1], plane[2]];
  const denom = vec3.dot(n, ray.direction);
  if (Math.abs(denom) < 1e-9) return null;
  const t = (plane[3] - vec3.dot(n, ray.origin)) / denom;
  return t >= 0 ? t : null;
}

/** Slab test. A ray starting inside the box hits at `t = 0`. */
export function intersectAabb(ray: Ray, box: Aabb): number | null {
  let tMin = 0;
  let tMax = Infinity;
  for (let i = 0; i < 3; i++) {
    const o = ray.origin[i];
    const d = ray.direction[i];
    if (Math.abs(d) < 1e-12) {
      if (o < box.min[i] || o > box.max[i]) return null;
      continue;
    }
    let t0 = (box.min[i] - o) / d;
    let t1 = (box.max[i] - o) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tMin = Math.max(tMin, t0);
    tMax = Math.min(tMax, t1);
    if (tMin > tMax) return null;
  }
  return tMin;
}

/** Moller-Trumbore, both faces. */
export function intersectTriangle(
  ray: Ray,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): number | null {
  const e1 = vec3.sub(b, a);
  const e2 = vec3.sub(c, a);
  const p = vec3.cross(ray.direction, e2);
  const det = vec3.dot(e1, p);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const s = vec3.sub(ray.origin, a);
  const u = vec3.dot(s, p) * inv;
  if (u < 0 || u > 1) return null;
  const q = vec3.cross(s, e1);
  const v = vec3.dot(ray.direction, q) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = vec3.dot(e2, q) * inv;
  return t >= 0 ? t : null;
}

export function intersectSphere(
  ray: Ray,
  center: Vec3,
  radius: number,
): number | null {
  const oc = vec3.sub(ray.origin, center);
  const b = vec3.dot(oc, ray.direction);
  const c = vec3.dot(oc, oc) - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const t0 = -b - root;
  if (t0 >= 0) return t0;
  const t1 = -b + root;
  return t1 >= 0 ? t1 : null;
}

// Aabb helpers ----------------------------------------------------------------

export const aabbEmpty = (): Aabb => ({
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
});

export const aabbIsEmpty = (box: Aabb): boolean =>
  box.min[0] > box.max[0] || box.min[1] > box.max[1] || box.min[2] > box.max[2];

export function aabbExpand(box: Aabb, point: Vec3): Aabb {
  return { min: vec3.min(box.min, point), max: vec3.max(box.max, point) };
}

export function aabbUnion(a: Aabb, b: Aabb): Aabb {
  return { min: vec3.min(a.min, b.min), max: vec3.max(a.max, b.max) };
}

export function aabbFromPoints(points: Iterable<Vec3>): Aabb {
  let box = aabbEmpty();
  for (const p of points) box = aabbExpand(box, p);
  return box;
}

export const aabbCenter = (box: Aabb): Vec3 =>
  vec3.scale(vec3.add(box.min, box.max), 0.5);

export const aabbSize = (box: Aabb): Vec3 => vec3.sub(box.max, box.min);

export function aabbContains(box: Aabb, p: Vec3): boolean {
  return p[0] >= box.min[0] && p[0] <= box.max[0] && p[1] >= box.min[1] &&
    p[1] <= box.max[1] && p[2] >= box.min[2] && p[2] <= box.max[2];
}

export function aabbCorners(box: Aabb): Vec3[] {
  const { min, max } = box;
  const out: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    out.push([
      i & 1 ? max[0] : min[0],
      i & 2 ? max[1] : min[1],
      i & 4 ? max[2] : min[2],
    ]);
  }
  return out;
}

/** The box that bounds this box after an affine transform. */
export function aabbTransform(box: Aabb, m: Mat4): Aabb {
  return aabbFromPoints(aabbCorners(box).map((p) => transformPoint(m, p)));
}
