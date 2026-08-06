import type { Mat4 } from "@ink/math/matrix.ts";
import { vec3 } from "@ink/math/vector.ts";
import type { Aabb, Plane, Sphere } from "./shapes.ts";
import { plane } from "./shapes.ts";
import { plane_signed_distance } from "./queries.ts";

declare const frustum_brand: unique symbol;

export interface Frustum {
  readonly left: Plane;
  readonly right: Plane;
  readonly bottom: Plane;
  readonly top: Plane;
  readonly near: Plane;
  readonly far: Plane;
  readonly planes: readonly Plane[];
  readonly [frustum_brand]: true;
}

export type ContainmentClassification = "outside" | "intersecting" | "inside";

export function frustum(
  left: Plane,
  right: Plane,
  bottom: Plane,
  top: Plane,
  near: Plane,
  far: Plane,
): Frustum {
  const planes = Object.freeze([left, right, bottom, top, near, far]);
  return Object.freeze({
    left,
    right,
    bottom,
    top,
    near,
    far,
    planes,
  }) as Frustum;
}

function plane_from_coefficients(
  x: number,
  y: number,
  z: number,
  w: number,
): Plane {
  return plane(vec3(x, y, z), w);
}

export function frustum_from_view_projection(matrix: Mat4): Frustum {
  return frustum(
    plane_from_coefficients(
      matrix[3] + matrix[0],
      matrix[7] + matrix[4],
      matrix[11] + matrix[8],
      matrix[15] + matrix[12],
    ),
    plane_from_coefficients(
      matrix[3] - matrix[0],
      matrix[7] - matrix[4],
      matrix[11] - matrix[8],
      matrix[15] - matrix[12],
    ),
    plane_from_coefficients(
      matrix[3] + matrix[1],
      matrix[7] + matrix[5],
      matrix[11] + matrix[9],
      matrix[15] + matrix[13],
    ),
    plane_from_coefficients(
      matrix[3] - matrix[1],
      matrix[7] - matrix[5],
      matrix[11] - matrix[9],
      matrix[15] - matrix[13],
    ),
    plane_from_coefficients(matrix[2], matrix[6], matrix[10], matrix[14]),
    plane_from_coefficients(
      matrix[3] - matrix[2],
      matrix[7] - matrix[6],
      matrix[11] - matrix[10],
      matrix[15] - matrix[14],
    ),
  );
}

export function frustum_contains_sphere(
  value: Frustum,
  bounds: Sphere,
): ContainmentClassification {
  let classification: ContainmentClassification = "inside";
  for (const clipping_plane of value.planes) {
    const distance = plane_signed_distance(clipping_plane, bounds.center);
    if (distance < -bounds.radius) return "outside";
    if (distance <= bounds.radius) classification = "intersecting";
  }
  return classification;
}

export function frustum_contains_aabb(
  value: Frustum,
  bounds: Aabb,
): ContainmentClassification {
  let classification: ContainmentClassification = "inside";
  for (const clipping_plane of value.planes) {
    const positive = vec3(
      clipping_plane.normal.x >= 0 ? bounds.maximum.x : bounds.minimum.x,
      clipping_plane.normal.y >= 0 ? bounds.maximum.y : bounds.minimum.y,
      clipping_plane.normal.z >= 0 ? bounds.maximum.z : bounds.minimum.z,
    );
    if (plane_signed_distance(clipping_plane, positive) < 0) return "outside";
    const negative = vec3(
      clipping_plane.normal.x >= 0 ? bounds.minimum.x : bounds.maximum.x,
      clipping_plane.normal.y >= 0 ? bounds.minimum.y : bounds.maximum.y,
      clipping_plane.normal.z >= 0 ? bounds.minimum.z : bounds.maximum.z,
    );
    if (plane_signed_distance(clipping_plane, negative) <= 0) {
      classification = "intersecting";
    }
  }
  return classification;
}
