import type { Quat } from "@ink/math/quaternion.ts";
import { finite_number } from "@ink/math/scalar.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import {
  vec3,
  vec3_add,
  vec3_cross,
  vec3_dot,
  vec3_length,
  vec3_normalize,
  vec3_scale,
  vec3_subtract,
} from "@ink/math/vector.ts";

declare const ray_brand: unique symbol;
declare const line_segment_brand: unique symbol;
declare const plane_brand: unique symbol;
declare const triangle_brand: unique symbol;
declare const sphere_brand: unique symbol;
declare const capsule_brand: unique symbol;
declare const aabb_brand: unique symbol;
declare const obb_brand: unique symbol;

export interface Ray {
  readonly origin: Vec3;
  readonly direction: Vec3;
  readonly [ray_brand]: true;
}

export interface LineSegment {
  readonly start: Vec3;
  readonly finish: Vec3;
  readonly [line_segment_brand]: true;
}

export interface Plane {
  readonly normal: Vec3;
  readonly offset: number;
  readonly [plane_brand]: true;
}

export interface Triangle {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
  readonly [triangle_brand]: true;
}

export interface Sphere {
  readonly center: Vec3;
  readonly radius: number;
  readonly [sphere_brand]: true;
}

export interface Capsule {
  readonly axis: LineSegment;
  readonly radius: number;
  readonly [capsule_brand]: true;
}

export interface Aabb {
  readonly minimum: Vec3;
  readonly maximum: Vec3;
  readonly [aabb_brand]: true;
}

export interface Obb {
  readonly center: Vec3;
  readonly half_extents: Vec3;
  readonly orientation: Quat;
  readonly [obb_brand]: true;
}

export function ray(origin: Vec3, direction: Vec3): Ray {
  return Object.freeze({ origin, direction: vec3_normalize(direction) }) as Ray;
}

export function line_segment(start: Vec3, finish: Vec3): LineSegment {
  if (start.x === finish.x && start.y === finish.y && start.z === finish.z) {
    throw new Error(
      `line segment endpoints are both (${start.x}, ${start.y}, ${start.z})`,
    );
  }
  return Object.freeze({ start, finish }) as LineSegment;
}

export function plane(normal: Vec3, offset: number): Plane {
  finite_number(offset, "plane offset");
  const normal_length = vec3_length(normal);
  if (normal_length === 0) {
    throw new Error(
      `plane normal is zero (${normal.x}, ${normal.y}, ${normal.z})`,
    );
  }
  return Object.freeze({
    normal: vec3_scale(normal, 1 / normal_length),
    offset: offset / normal_length,
  }) as Plane;
}

export function plane_from_point_normal(point: Vec3, normal: Vec3): Plane {
  const normalized_normal = vec3_normalize(normal);
  return plane(normalized_normal, -vec3_dot(normalized_normal, point));
}

export function triangle(a: Vec3, b: Vec3, c: Vec3): Triangle {
  const doubled_area = vec3_length(
    vec3_cross(vec3_subtract(b, a), vec3_subtract(c, a)),
  );
  if (doubled_area === 0) {
    throw new Error(
      `triangle is degenerate at (${a.x}, ${a.y}, ${a.z}), (${b.x}, ${b.y}, ${b.z}), (${c.x}, ${c.y}, ${c.z})`,
    );
  }
  return Object.freeze({ a, b, c }) as Triangle;
}

export function sphere(center: Vec3, radius: number): Sphere {
  finite_number(radius, "sphere radius");
  if (radius <= 0) {
    throw new Error(`sphere radius must be positive, received ${radius}`);
  }
  return Object.freeze({ center, radius }) as Sphere;
}

export function capsule(axis: LineSegment, radius: number): Capsule {
  finite_number(radius, "capsule radius");
  if (radius <= 0) {
    throw new Error(`capsule radius must be positive, received ${radius}`);
  }
  return Object.freeze({ axis, radius }) as Capsule;
}

export function aabb(minimum: Vec3, maximum: Vec3): Aabb {
  if (
    minimum.x > maximum.x || minimum.y > maximum.y || minimum.z > maximum.z
  ) {
    throw new Error(
      `AABB minimum (${minimum.x}, ${minimum.y}, ${minimum.z}) exceeds maximum (${maximum.x}, ${maximum.y}, ${maximum.z})`,
    );
  }
  return Object.freeze({ minimum, maximum }) as Aabb;
}

export function obb(
  center: Vec3,
  half_extents: Vec3,
  orientation: Quat,
): Obb {
  if (
    half_extents.x <= 0 || half_extents.y <= 0 || half_extents.z <= 0
  ) {
    throw new Error(
      `OBB half-extents must be positive, received (${half_extents.x}, ${half_extents.y}, ${half_extents.z})`,
    );
  }
  return Object.freeze({ center, half_extents, orientation }) as Obb;
}

export function aabb_center(bounds: Aabb): Vec3 {
  return vec3_scale(vec3_add(bounds.minimum, bounds.maximum), 0.5);
}

export function aabb_extents(bounds: Aabb): Vec3 {
  return vec3_subtract(bounds.maximum, bounds.minimum);
}

export function aabb_surface_area(bounds: Aabb): number {
  const extents = aabb_extents(bounds);
  return 2 *
    (extents.x * extents.y + extents.y * extents.z + extents.z * extents.x);
}

export function aabb_union(left: Aabb, right: Aabb): Aabb {
  return aabb(
    vec3(
      Math.min(left.minimum.x, right.minimum.x),
      Math.min(left.minimum.y, right.minimum.y),
      Math.min(left.minimum.z, right.minimum.z),
    ),
    vec3(
      Math.max(left.maximum.x, right.maximum.x),
      Math.max(left.maximum.y, right.maximum.y),
      Math.max(left.maximum.z, right.maximum.z),
    ),
  );
}

export function aabb_expand(bounds: Aabb, amount: number): Aabb {
  finite_number(amount, "AABB expansion");
  if (amount < 0) {
    throw new Error(`AABB expansion must be non-negative, received ${amount}`);
  }
  const expansion = vec3(amount, amount, amount);
  return aabb(
    vec3_subtract(bounds.minimum, expansion),
    vec3_add(bounds.maximum, expansion),
  );
}

export function aabb_from_points(points: readonly Vec3[]): Aabb {
  if (points.length === 0) {
    throw new Error("cannot construct AABB from 0 points");
  }
  let minimum_x = points[0].x;
  let minimum_y = points[0].y;
  let minimum_z = points[0].z;
  let maximum_x = points[0].x;
  let maximum_y = points[0].y;
  let maximum_z = points[0].z;
  for (let index = 1; index < points.length; index++) {
    const point = points[index];
    minimum_x = Math.min(minimum_x, point.x);
    minimum_y = Math.min(minimum_y, point.y);
    minimum_z = Math.min(minimum_z, point.z);
    maximum_x = Math.max(maximum_x, point.x);
    maximum_y = Math.max(maximum_y, point.y);
    maximum_z = Math.max(maximum_z, point.z);
  }
  return aabb(
    vec3(minimum_x, minimum_y, minimum_z),
    vec3(maximum_x, maximum_y, maximum_z),
  );
}

export function triangle_normal(value: Triangle): Vec3 {
  return vec3_normalize(
    vec3_cross(
      vec3_subtract(value.b, value.a),
      vec3_subtract(value.c, value.a),
    ),
  );
}
