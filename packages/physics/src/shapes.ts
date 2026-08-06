import type { Aabb } from "@ink/geometry/shapes.ts";
import { aabb, aabb_from_points } from "@ink/geometry/shapes.ts";
import type { MeshTopology } from "@ink/geometry/mesh.ts";
import { finite_number } from "@ink/math/scalar.ts";
import type { Transform } from "@ink/math/transform.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import {
  vec3,
  vec3_dot,
  vec3_length_squared,
  vec3_scale,
} from "@ink/math/vector.ts";

export type CollisionShape =
  | SphereShape
  | CapsuleShape
  | BoxShape
  | ConvexHullShape
  | HeightfieldShape
  | TriangleMeshShape;

export interface SphereShape {
  readonly type: "sphere";
  readonly radius: number;
}

export interface CapsuleShape {
  readonly type: "capsule";
  readonly half_height: number;
  readonly radius: number;
}

export interface BoxShape {
  readonly type: "box";
  readonly half_extents: Vec3;
}

export interface ConvexHullShape {
  readonly type: "convex_hull";
  readonly points: readonly Vec3[];
  readonly bounds: Aabb;
}

export interface HeightfieldShape {
  readonly type: "heightfield";
  readonly width: number;
  readonly depth: number;
  readonly spacing: number;
  readonly heights: Float32Array;
  readonly holes: Uint8Array;
  readonly bounds: Aabb;
}

export interface TriangleMeshShape {
  readonly type: "triangle_mesh";
  readonly topology: MeshTopology;
  readonly bounds: Aabb;
}

export interface MassProperties {
  readonly mass: number;
  readonly center: Vec3;
  readonly inertia: Vec3;
}

export function sphere_shape(radius: number): SphereShape {
  return Object.freeze({
    type: "sphere",
    radius: positive(radius, "sphere radius"),
  });
}

export function capsule_shape(
  half_height: number,
  radius: number,
): CapsuleShape {
  return Object.freeze({
    type: "capsule",
    half_height: nonnegative(half_height, "capsule half-height"),
    radius: positive(radius, "capsule radius"),
  });
}

export function box_shape(half_extents: Vec3): BoxShape {
  if (
    half_extents.x <= 0 || half_extents.y <= 0 || half_extents.z <= 0
  ) {
    throw new Error(
      `box half-extents (${half_extents.x}, ${half_extents.y}, ${half_extents.z}) must be positive`,
    );
  }
  return Object.freeze({ type: "box", half_extents });
}

export function convex_hull_shape(points: readonly Vec3[]): ConvexHullShape {
  if (points.length < 4) {
    throw new Error(
      `convex hull requires at least 4 points, received ${points.length}`,
    );
  }
  const copied = Object.freeze([...points]);
  const origin = copied[0];
  const first = copied.find((point) =>
    vec3_length_squared(subtract(point, origin)) > 0
  );
  if (first === undefined) {
    throw new Error("convex hull points are all coincident");
  }
  const second = copied.find((point) => {
    const cross = cross_product(
      subtract(first, origin),
      subtract(point, origin),
    );
    return vec3_length_squared(cross) > 1e-18;
  });
  if (second === undefined) throw new Error("convex hull points are collinear");
  const normal = cross_product(
    subtract(first, origin),
    subtract(second, origin),
  );
  if (
    !copied.some((point) =>
      Math.abs(vec3_dot(normal, subtract(point, origin))) > 1e-9
    )
  ) {
    throw new Error("convex hull points are coplanar");
  }
  return Object.freeze({
    type: "convex_hull",
    points: copied,
    bounds: aabb_from_points(copied),
  });
}

export function heightfield_shape(options: {
  readonly width: number;
  readonly depth: number;
  readonly spacing: number;
  readonly heights: Float32Array;
  readonly holes?: Uint8Array;
}): HeightfieldShape {
  const width = grid_size(options.width, "heightfield width");
  const depth = grid_size(options.depth, "heightfield depth");
  const spacing = positive(options.spacing, "heightfield spacing");
  if (options.heights.length !== width * depth) {
    throw new Error(
      `heightfield heights length ${options.heights.length} must equal ${
        width * depth
      }`,
    );
  }
  for (const [index, height] of options.heights.entries()) {
    finite_number(height, `heightfield height ${index}`);
  }
  const holes = options.holes ?? new Uint8Array((width - 1) * (depth - 1));
  if (holes.length !== (width - 1) * (depth - 1)) {
    throw new Error(
      `heightfield holes length ${holes.length} must equal ${
        (width - 1) * (depth - 1)
      }`,
    );
  }
  if ([...holes].some((hole) => hole !== 0 && hole !== 1)) {
    throw new Error("heightfield holes must contain only 0 or 1");
  }
  let minimum_height = options.heights[0];
  let maximum_height = options.heights[0];
  for (const height of options.heights) {
    minimum_height = Math.min(minimum_height, height);
    maximum_height = Math.max(maximum_height, height);
  }
  return Object.freeze({
    type: "heightfield",
    width,
    depth,
    spacing,
    heights: options.heights.slice(),
    holes: holes.slice(),
    bounds: aabb(
      vec3(0, minimum_height, 0),
      vec3((width - 1) * spacing, maximum_height, (depth - 1) * spacing),
    ),
  });
}

export function triangle_mesh_shape(topology: MeshTopology): TriangleMeshShape {
  return Object.freeze({
    type: "triangle_mesh",
    topology,
    bounds: aabb_from_points(topology.positions),
  });
}

export function shape_mass_properties(
  shape: CollisionShape,
  density: number,
): MassProperties {
  const parsed_density = positive(density, "shape density");
  const center = vec3(0, 0, 0);
  if (shape.type === "sphere") {
    const mass = 4 / 3 * Math.PI * shape.radius ** 3 * parsed_density;
    const inertia = 2 / 5 * mass * shape.radius ** 2;
    return Object.freeze({
      mass,
      center,
      inertia: vec3(inertia, inertia, inertia),
    });
  }
  if (shape.type === "capsule") {
    const cylinder_height = shape.half_height * 2;
    const cylinder_mass = Math.PI * shape.radius ** 2 * cylinder_height *
      parsed_density;
    const sphere_mass = 4 / 3 * Math.PI * shape.radius ** 3 * parsed_density;
    const mass = cylinder_mass + sphere_mass;
    const radial = mass * (3 * shape.radius ** 2 + cylinder_height ** 2) / 12;
    const axial = mass * shape.radius ** 2 / 2;
    return Object.freeze({
      mass,
      center,
      inertia: vec3(radial, axial, radial),
    });
  }
  const bounds = local_shape_bounds(shape);
  const extents = vec3(
    bounds.maximum.x - bounds.minimum.x,
    bounds.maximum.y - bounds.minimum.y,
    bounds.maximum.z - bounds.minimum.z,
  );
  const mass = extents.x * extents.y * extents.z * parsed_density;
  return Object.freeze({
    mass,
    center,
    inertia: vec3(
      mass * (extents.y ** 2 + extents.z ** 2) / 12,
      mass * (extents.x ** 2 + extents.z ** 2) / 12,
      mass * (extents.x ** 2 + extents.y ** 2) / 12,
    ),
  });
}

export function local_shape_bounds(shape: CollisionShape): Aabb {
  switch (shape.type) {
    case "sphere": {
      const radius = vec3(shape.radius, shape.radius, shape.radius);
      return aabb(vec3_scale(radius, -1), radius);
    }
    case "capsule":
      return aabb(
        vec3(-shape.radius, -shape.half_height - shape.radius, -shape.radius),
        vec3(shape.radius, shape.half_height + shape.radius, shape.radius),
      );
    case "box":
      return aabb(vec3_scale(shape.half_extents, -1), shape.half_extents);
    case "convex_hull":
    case "heightfield":
    case "triangle_mesh":
      return shape.bounds;
  }
}

export function shape_support(shape: CollisionShape, direction: Vec3): Vec3 {
  switch (shape.type) {
    case "sphere": {
      const length = Math.hypot(direction.x, direction.y, direction.z);
      if (length === 0) return vec3(shape.radius, 0, 0);
      return vec3_scale(direction, shape.radius / length);
    }
    case "capsule": {
      const length = Math.hypot(direction.x, direction.y, direction.z);
      if (length === 0) return vec3(shape.radius, shape.half_height, 0);
      const end_y = direction.y >= 0 ? shape.half_height : -shape.half_height;
      const radial = vec3_scale(direction, shape.radius / length);
      return vec3(radial.x, radial.y + end_y, radial.z);
    }
    case "box":
      return vec3(
        direction.x >= 0 ? shape.half_extents.x : -shape.half_extents.x,
        direction.y >= 0 ? shape.half_extents.y : -shape.half_extents.y,
        direction.z >= 0 ? shape.half_extents.z : -shape.half_extents.z,
      );
    case "convex_hull":
      return furthest(shape.points, direction);
    case "heightfield": {
      const points: Vec3[] = [];
      for (let z = 0; z < shape.depth; z++) {
        for (let x = 0; x < shape.width; x++) {
          points.push(
            vec3(
              x * shape.spacing,
              shape.heights[z * shape.width + x],
              z * shape.spacing,
            ),
          );
        }
      }
      return furthest(points, direction);
    }
    case "triangle_mesh":
      return furthest(shape.topology.positions, direction);
  }
}

export function uniform_physics_transform(transform: Transform): void {
  if (
    Math.abs(transform.scale.x - transform.scale.y) > 1e-9 ||
    Math.abs(transform.scale.x - transform.scale.z) > 1e-9 ||
    transform.scale.x <= 0
  ) {
    throw new Error(
      `physics transform scale (${transform.scale.x}, ${transform.scale.y}, ${transform.scale.z}) must be positive and uniform`,
    );
  }
}

function furthest(points: readonly Vec3[], direction: Vec3): Vec3 {
  let result = points[0];
  let maximum = vec3_dot(result, direction);
  for (let index = 1; index < points.length; index++) {
    const projection = vec3_dot(points[index], direction);
    if (projection > maximum) {
      maximum = projection;
      result = points[index];
    }
  }
  return result;
}

function positive(value: number, label: string): number {
  finite_number(value, label);
  if (value <= 0) throw new Error(`${label} ${value} must be positive`);
  return value;
}

function nonnegative(value: number, label: string): number {
  finite_number(value, label);
  if (value < 0) throw new Error(`${label} ${value} must be nonnegative`);
  return value;
}

function grid_size(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 2) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be an integer of at least 2`,
    );
  }
  return value;
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return vec3(left.x - right.x, left.y - right.y, left.z - right.z);
}

function cross_product(left: Vec3, right: Vec3): Vec3 {
  return vec3(
    left.y * right.z - left.z * right.y,
    left.z * right.x - left.x * right.z,
    left.x * right.y - left.y * right.x,
  );
}
