import { quat_inverse, quat_rotate_vec3 } from "@ink/math/quaternion.ts";
import { clamp, DEFAULT_EPSILON, finite_number } from "@ink/math/scalar.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import {
  vec3,
  vec3_add,
  vec3_cross,
  vec3_dot,
  vec3_length,
  vec3_length_squared,
  vec3_normalize,
  vec3_scale,
  vec3_subtract,
} from "@ink/math/vector.ts";
import type {
  Aabb,
  Capsule,
  LineSegment,
  Obb,
  Plane,
  Ray,
  Sphere,
  Triangle,
} from "./shapes.ts";
import { aabb, aabb_expand, ray, triangle_normal } from "./shapes.ts";

export type PointContainment = "outside" | "boundary" | "inside";
export type OverlapClassification = "disjoint" | "touching" | "overlapping";
type AabbFace = "x_min" | "x_max" | "y_min" | "y_max" | "z_min" | "z_max";

export interface GeometryHit<Feature extends string | number = string> {
  readonly distance: number;
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly feature: Feature;
}

function query_epsilon(epsilon: number): void {
  finite_number(epsilon, "geometry query epsilon");
  if (epsilon < 0) {
    throw new Error(
      `geometry query epsilon must be non-negative, received ${epsilon}`,
    );
  }
}

function geometry_hit<Feature extends string | number>(
  distance: number,
  position: Vec3,
  normal: Vec3,
  feature: Feature,
): GeometryHit<Feature> {
  return Object.freeze({ distance, position, normal, feature });
}

export function plane_signed_distance(value: Plane, point: Vec3): number {
  return finite_number(
    vec3_dot(value.normal, point) + value.offset,
    "plane signed distance",
  );
}

export function closest_point_on_segment(
  point: Vec3,
  segment: LineSegment,
): Vec3 {
  const direction = vec3_subtract(segment.finish, segment.start);
  const amount = clamp(
    vec3_dot(vec3_subtract(point, segment.start), direction) /
      vec3_length_squared(direction),
    0,
    1,
  );
  return vec3_add(segment.start, vec3_scale(direction, amount));
}

export function closest_point_on_aabb(point: Vec3, bounds: Aabb): Vec3 {
  return vec3(
    clamp(point.x, bounds.minimum.x, bounds.maximum.x),
    clamp(point.y, bounds.minimum.y, bounds.maximum.y),
    clamp(point.z, bounds.minimum.z, bounds.maximum.z),
  );
}

export function closest_point_on_triangle(
  point: Vec3,
  value: Triangle,
): Vec3 {
  const ab = vec3_subtract(value.b, value.a);
  const ac = vec3_subtract(value.c, value.a);
  const ap = vec3_subtract(point, value.a);
  const d1 = vec3_dot(ab, ap);
  const d2 = vec3_dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return value.a;

  const bp = vec3_subtract(point, value.b);
  const d3 = vec3_dot(ab, bp);
  const d4 = vec3_dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return value.b;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    return vec3_add(value.a, vec3_scale(ab, d1 / (d1 - d3)));
  }

  const cp = vec3_subtract(point, value.c);
  const d5 = vec3_dot(ab, cp);
  const d6 = vec3_dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return value.c;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    return vec3_add(value.a, vec3_scale(ac, d2 / (d2 - d6)));
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const edge = vec3_subtract(value.c, value.b);
    return vec3_add(
      value.b,
      vec3_scale(edge, (d4 - d3) / ((d4 - d3) + (d5 - d6))),
    );
  }

  const denominator = 1 / (va + vb + vc);
  return vec3_add(
    value.a,
    vec3_add(
      vec3_scale(ab, vb * denominator),
      vec3_scale(ac, vc * denominator),
    ),
  );
}

export function sphere_contains_point(
  value: Sphere,
  point: Vec3,
  epsilon = DEFAULT_EPSILON,
): PointContainment {
  query_epsilon(epsilon);
  const distance = vec3_length(vec3_subtract(point, value.center));
  if (distance > value.radius + epsilon) return "outside";
  if (Math.abs(distance - value.radius) <= epsilon) return "boundary";
  return "inside";
}

export function aabb_contains_point(
  bounds: Aabb,
  point: Vec3,
  epsilon = DEFAULT_EPSILON,
): PointContainment {
  query_epsilon(epsilon);
  if (
    point.x < bounds.minimum.x - epsilon ||
    point.y < bounds.minimum.y - epsilon ||
    point.z < bounds.minimum.z - epsilon ||
    point.x > bounds.maximum.x + epsilon ||
    point.y > bounds.maximum.y + epsilon ||
    point.z > bounds.maximum.z + epsilon
  ) return "outside";
  if (
    Math.abs(point.x - bounds.minimum.x) <= epsilon ||
    Math.abs(point.y - bounds.minimum.y) <= epsilon ||
    Math.abs(point.z - bounds.minimum.z) <= epsilon ||
    Math.abs(point.x - bounds.maximum.x) <= epsilon ||
    Math.abs(point.y - bounds.maximum.y) <= epsilon ||
    Math.abs(point.z - bounds.maximum.z) <= epsilon
  ) return "boundary";
  return "inside";
}

export function capsule_contains_point(
  value: Capsule,
  point: Vec3,
  epsilon = DEFAULT_EPSILON,
): PointContainment {
  query_epsilon(epsilon);
  const closest = closest_point_on_segment(point, value.axis);
  const distance = vec3_length(vec3_subtract(point, closest));
  if (distance > value.radius + epsilon) return "outside";
  if (Math.abs(distance - value.radius) <= epsilon) return "boundary";
  return "inside";
}

export function obb_contains_point(
  bounds: Obb,
  point: Vec3,
  epsilon = DEFAULT_EPSILON,
): PointContainment {
  query_epsilon(epsilon);
  const local = quat_rotate_vec3(
    quat_inverse(bounds.orientation),
    vec3_subtract(point, bounds.center),
  );
  return aabb_contains_point(
    aabb(vec3_scale(bounds.half_extents, -1), bounds.half_extents),
    local,
    epsilon,
  );
}

export function aabb_overlap(
  left: Aabb,
  right: Aabb,
  epsilon = DEFAULT_EPSILON,
): OverlapClassification {
  query_epsilon(epsilon);
  const overlap_x = Math.min(left.maximum.x, right.maximum.x) -
    Math.max(left.minimum.x, right.minimum.x);
  const overlap_y = Math.min(left.maximum.y, right.maximum.y) -
    Math.max(left.minimum.y, right.minimum.y);
  const overlap_z = Math.min(left.maximum.z, right.maximum.z) -
    Math.max(left.minimum.z, right.minimum.z);
  if (overlap_x < -epsilon || overlap_y < -epsilon || overlap_z < -epsilon) {
    return "disjoint";
  }
  if (
    Math.abs(overlap_x) <= epsilon || Math.abs(overlap_y) <= epsilon ||
    Math.abs(overlap_z) <= epsilon
  ) return "touching";
  return "overlapping";
}

export function sphere_overlap(
  left: Sphere,
  right: Sphere,
  epsilon = DEFAULT_EPSILON,
): OverlapClassification {
  query_epsilon(epsilon);
  const separation = vec3_length(vec3_subtract(left.center, right.center));
  const radius_sum = left.radius + right.radius;
  if (separation > radius_sum + epsilon) return "disjoint";
  if (Math.abs(separation - radius_sum) <= epsilon) return "touching";
  return "overlapping";
}

export function sphere_aabb_overlap(
  value: Sphere,
  bounds: Aabb,
  epsilon = DEFAULT_EPSILON,
): OverlapClassification {
  query_epsilon(epsilon);
  const closest = closest_point_on_aabb(value.center, bounds);
  const distance = vec3_length(vec3_subtract(value.center, closest));
  if (distance > value.radius + epsilon) return "disjoint";
  if (Math.abs(distance - value.radius) <= epsilon) return "touching";
  return "overlapping";
}

export function ray_plane_intersection(
  cast: Ray,
  value: Plane,
  epsilon = DEFAULT_EPSILON,
): GeometryHit<"front" | "back" | "coplanar"> | null {
  query_epsilon(epsilon);
  const denominator = vec3_dot(value.normal, cast.direction);
  const signed_distance = plane_signed_distance(value, cast.origin);
  if (Math.abs(denominator) <= epsilon) {
    if (Math.abs(signed_distance) > epsilon) return null;
    return geometry_hit(0, cast.origin, value.normal, "coplanar");
  }
  const distance = -signed_distance / denominator;
  if (distance < 0) return null;
  return geometry_hit(
    distance,
    vec3_add(cast.origin, vec3_scale(cast.direction, distance)),
    denominator < 0 ? value.normal : vec3_scale(value.normal, -1),
    denominator < 0 ? "front" : "back",
  );
}

export function ray_sphere_intersection(
  cast: Ray,
  value: Sphere,
): GeometryHit<"surface" | "interior"> | null {
  const offset = vec3_subtract(cast.origin, value.center);
  const c = vec3_dot(offset, offset) - value.radius * value.radius;
  if (c <= 0) {
    return geometry_hit(
      0,
      cast.origin,
      vec3_scale(cast.direction, -1),
      "interior",
    );
  }
  const b = vec3_dot(offset, cast.direction);
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const distance = -b - Math.sqrt(discriminant);
  if (distance < 0) return null;
  const position = vec3_add(cast.origin, vec3_scale(cast.direction, distance));
  return geometry_hit(
    distance,
    position,
    vec3_normalize(vec3_subtract(position, value.center)),
    "surface",
  );
}

export function ray_aabb_intersection(
  cast: Ray,
  bounds: Aabb,
  maximum_distance = Infinity,
):
  | GeometryHit<
    "x_min" | "x_max" | "y_min" | "y_max" | "z_min" | "z_max" | "interior"
  >
  | null {
  if (Number.isNaN(maximum_distance) || maximum_distance < 0) {
    throw new Error(
      `maximum ray distance must be non-negative, received ${
        String(maximum_distance)
      }`,
    );
  }
  if (aabb_contains_point(bounds, cast.origin) !== "outside") {
    return geometry_hit(
      0,
      cast.origin,
      vec3_scale(cast.direction, -1),
      "interior",
    );
  }
  let entry = 0;
  let exit = maximum_distance;
  let feature: AabbFace = "x_min";
  let normal = vec3(-1, 0, 0);
  const axes = [
    {
      origin: cast.origin.x,
      direction: cast.direction.x,
      minimum: bounds.minimum.x,
      maximum: bounds.maximum.x,
      low: "x_min",
      high: "x_max",
      low_normal: vec3(-1, 0, 0),
      high_normal: vec3(1, 0, 0),
    },
    {
      origin: cast.origin.y,
      direction: cast.direction.y,
      minimum: bounds.minimum.y,
      maximum: bounds.maximum.y,
      low: "y_min",
      high: "y_max",
      low_normal: vec3(0, -1, 0),
      high_normal: vec3(0, 1, 0),
    },
    {
      origin: cast.origin.z,
      direction: cast.direction.z,
      minimum: bounds.minimum.z,
      maximum: bounds.maximum.z,
      low: "z_min",
      high: "z_max",
      low_normal: vec3(0, 0, -1),
      high_normal: vec3(0, 0, 1),
    },
  ] as const;
  for (const axis of axes) {
    if (axis.direction === 0) {
      if (axis.origin < axis.minimum || axis.origin > axis.maximum) return null;
      continue;
    }
    const inverse_direction = 1 / axis.direction;
    let near = (axis.minimum - axis.origin) * inverse_direction;
    let far = (axis.maximum - axis.origin) * inverse_direction;
    let near_feature: AabbFace = axis.low;
    let near_normal = axis.low_normal;
    if (near > far) {
      [near, far] = [far, near];
      near_feature = axis.high;
      near_normal = axis.high_normal;
    }
    if (near > entry) {
      entry = near;
      feature = near_feature;
      normal = near_normal;
    }
    exit = Math.min(exit, far);
    if (entry > exit) return null;
  }
  if (entry > maximum_distance) return null;
  return geometry_hit(
    entry,
    vec3_add(cast.origin, vec3_scale(cast.direction, entry)),
    normal,
    feature,
  );
}

export function ray_triangle_intersection(
  cast: Ray,
  value: Triangle,
  epsilon = DEFAULT_EPSILON,
): GeometryHit<"front" | "back"> | null {
  query_epsilon(epsilon);
  const edge_ab = vec3_subtract(value.b, value.a);
  const edge_ac = vec3_subtract(value.c, value.a);
  const perpendicular = vec3_cross(cast.direction, edge_ac);
  const determinant = vec3_dot(edge_ab, perpendicular);
  if (Math.abs(determinant) <= epsilon) return null;
  const inverse_determinant = 1 / determinant;
  const origin_offset = vec3_subtract(cast.origin, value.a);
  const u = vec3_dot(origin_offset, perpendicular) * inverse_determinant;
  if (u < -epsilon || u > 1 + epsilon) return null;
  const cross = vec3_cross(origin_offset, edge_ab);
  const v = vec3_dot(cast.direction, cross) * inverse_determinant;
  if (v < -epsilon || u + v > 1 + epsilon) return null;
  const distance = vec3_dot(edge_ac, cross) * inverse_determinant;
  if (distance < 0) return null;
  const source_normal = triangle_normal(value);
  const front = vec3_dot(source_normal, cast.direction) < 0;
  return geometry_hit(
    distance,
    vec3_add(cast.origin, vec3_scale(cast.direction, distance)),
    front ? source_normal : vec3_scale(source_normal, -1),
    front ? "front" : "back",
  );
}

export function sweep_sphere_aabb(
  moving: Sphere,
  direction: Vec3,
  maximum_distance: number,
  target: Aabb,
): GeometryHit<"surface" | "interior"> | null {
  finite_number(maximum_distance, "maximum sweep distance");
  if (maximum_distance < 0) {
    throw new Error(
      `maximum sweep distance must be non-negative, received ${maximum_distance}`,
    );
  }
  const expanded = aabb_expand(target, moving.radius);
  const hit = ray_aabb_intersection(
    ray(moving.center, direction),
    expanded,
    maximum_distance,
  );
  if (hit === null) return null;
  return geometry_hit(
    hit.distance,
    vec3_subtract(hit.position, vec3_scale(hit.normal, moving.radius)),
    hit.normal,
    hit.feature === "interior" ? "interior" : "surface",
  );
}
