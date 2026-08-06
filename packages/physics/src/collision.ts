import type { Aabb, Ray } from "@ink/geometry/shapes.ts";
import { aabb, ray, sphere, triangle } from "@ink/geometry/shapes.ts";
import {
  closest_point_on_aabb,
  closest_point_on_triangle,
  ray_aabb_intersection,
  ray_sphere_intersection,
  sweep_sphere_aabb,
} from "@ink/geometry/queries.ts";
import type { Quat } from "@ink/math/quaternion.ts";
import {
  quat_identity,
  quat_inverse,
  quat_multiply,
  quat_rotate_vec3,
} from "@ink/math/quaternion.ts";
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
import type { CollisionShape } from "./shapes.ts";
import { local_shape_bounds, shape_support } from "./shapes.ts";

export interface RigidPose {
  readonly position: Vec3;
  readonly rotation: Quat;
}

export interface ContactGeometry {
  readonly normal: Vec3;
  readonly point: Vec3;
  readonly penetration: number;
}

export interface ConvexIntersection {
  readonly intersects: boolean;
  readonly iterations: number;
  readonly simplex: readonly Vec3[];
}

export interface PenetrationEstimate {
  readonly normal: Vec3;
  readonly depth: number;
  readonly iterations: number;
}

export interface ShapeRayHit {
  readonly distance: number;
  readonly point: Vec3;
  readonly normal: Vec3;
}

export function rigid_pose(
  position: Vec3,
  rotation: Quat = quat_identity(),
): RigidPose {
  return Object.freeze({ position, rotation });
}

export function compose_rigid_pose(
  parent: RigidPose,
  local: RigidPose,
): RigidPose {
  return rigid_pose(
    vec3_add(
      parent.position,
      quat_rotate_vec3(parent.rotation, local.position),
    ),
    quat_multiply(parent.rotation, local.rotation),
  );
}

export function shape_world_bounds(
  shape: CollisionShape,
  pose: RigidPose,
): Aabb {
  if (shape.type === "sphere") {
    const radius = vec3(shape.radius, shape.radius, shape.radius);
    return aabb(
      vec3_subtract(pose.position, radius),
      vec3_add(pose.position, radius),
    );
  }
  const bounds = local_shape_bounds(shape);
  const corners: Vec3[] = [];
  for (const x of [bounds.minimum.x, bounds.maximum.x]) {
    for (const y of [bounds.minimum.y, bounds.maximum.y]) {
      for (const z of [bounds.minimum.z, bounds.maximum.z]) {
        corners.push(
          vec3_add(
            pose.position,
            quat_rotate_vec3(pose.rotation, vec3(x, y, z)),
          ),
        );
      }
    }
  }
  let minimum = corners[0];
  let maximum = corners[0];
  for (let index = 1; index < corners.length; index++) {
    const point = corners[index];
    minimum = vec3(
      Math.min(minimum.x, point.x),
      Math.min(minimum.y, point.y),
      Math.min(minimum.z, point.z),
    );
    maximum = vec3(
      Math.max(maximum.x, point.x),
      Math.max(maximum.y, point.y),
      Math.max(maximum.z, point.z),
    );
  }
  return aabb(minimum, maximum);
}

export function collide_shapes(
  left_shape: CollisionShape,
  left_pose: RigidPose,
  right_shape: CollisionShape,
  right_pose: RigidPose,
): ContactGeometry | null {
  if (left_shape.type === "sphere" && right_shape.type === "sphere") {
    return sphere_contact(
      left_shape.radius,
      left_pose.position,
      right_shape.radius,
      right_pose.position,
    );
  }
  if (left_shape.type === "sphere" && right_shape.type === "box") {
    return sphere_box_contact(
      left_shape.radius,
      left_pose.position,
      right_shape,
      right_pose,
    );
  }
  if (left_shape.type === "box" && right_shape.type === "sphere") {
    const contact = sphere_box_contact(
      right_shape.radius,
      right_pose.position,
      left_shape,
      left_pose,
    );
    return contact === null ? null : Object.freeze({
      normal: vec3_scale(contact.normal, -1),
      point: contact.point,
      penetration: contact.penetration,
    });
  }
  if (
    left_shape.type === "sphere" &&
    (right_shape.type === "heightfield" || right_shape.type === "triangle_mesh")
  ) {
    return sphere_concave_contact(
      left_shape.radius,
      left_pose.position,
      right_shape,
      right_pose,
    );
  }
  if (
    right_shape.type === "sphere" &&
    (left_shape.type === "heightfield" || left_shape.type === "triangle_mesh")
  ) {
    const contact = sphere_concave_contact(
      right_shape.radius,
      right_pose.position,
      left_shape,
      left_pose,
    );
    return contact === null ? null : Object.freeze({
      normal: vec3_scale(contact.normal, -1),
      point: contact.point,
      penetration: contact.penetration,
    });
  }
  const left_bounds = shape_world_bounds(left_shape, left_pose);
  const right_bounds = shape_world_bounds(right_shape, right_pose);
  const penetration = epa_penetration(
    left_shape,
    left_pose,
    right_shape,
    right_pose,
  );
  if (penetration === null) return null;
  const overlap = aabb_contact(left_bounds, right_bounds);
  return Object.freeze({
    normal: penetration.normal,
    point: overlap?.point ??
      vec3_scale(vec3_add(left_pose.position, right_pose.position), 0.5),
    penetration: penetration.depth,
  });
}

export function gjk_intersection(
  left_shape: CollisionShape,
  left_pose: RigidPose,
  right_shape: CollisionShape,
  right_pose: RigidPose,
  maximum_iterations = 24,
): ConvexIntersection {
  let direction = vec3_subtract(right_pose.position, left_pose.position);
  if (vec3_length_squared(direction) === 0) direction = vec3(1, 0, 0);
  const simplex: Vec3[] = [
    minkowski_support(
      left_shape,
      left_pose,
      right_shape,
      right_pose,
      direction,
    ),
  ];
  direction = vec3_scale(simplex[0], -1);
  for (let iteration = 1; iteration <= maximum_iterations; iteration++) {
    if (vec3_length_squared(direction) < 1e-18) {
      return frozen_intersection(true, iteration, simplex);
    }
    const point = minkowski_support(
      left_shape,
      left_pose,
      right_shape,
      right_pose,
      direction,
    );
    if (vec3_dot(point, direction) < 0) {
      return frozen_intersection(false, iteration, simplex);
    }
    simplex.unshift(point);
    const update = update_simplex(simplex);
    direction = update.direction;
    if (update.contains_origin) {
      return frozen_intersection(true, iteration, simplex);
    }
  }
  return frozen_intersection(false, maximum_iterations, simplex);
}

export function epa_penetration(
  left_shape: CollisionShape,
  left_pose: RigidPose,
  right_shape: CollisionShape,
  right_pose: RigidPose,
): PenetrationEstimate | null {
  const intersection = gjk_intersection(
    left_shape,
    left_pose,
    right_shape,
    right_pose,
  );
  if (!intersection.intersects) return null;
  const vertices = [...intersection.simplex];
  const seed_directions = [
    vec3(1, 0, 0),
    vec3(0, 1, 0),
    vec3(0, 0, 1),
    vec3(-1, 0, 0),
    vec3(0, -1, 0),
    vec3(0, 0, -1),
  ];
  for (const direction of seed_directions) {
    if (vertices.length >= 4 && tetrahedron_volume(vertices) > 1e-12) break;
    const point = minkowski_support(
      left_shape,
      left_pose,
      right_shape,
      right_pose,
      direction,
    );
    if (
      !vertices.some((vertex) =>
        vec3_length_squared(vec3_subtract(vertex, point)) < 1e-18
      )
    ) vertices.push(point);
  }
  if (vertices.length < 4 || tetrahedron_volume(vertices) <= 1e-12) {
    return sat_penetration(left_shape, left_pose, right_shape, right_pose);
  }
  const polytope = vertices.slice(0, 4);
  let faces = [
    epa_face(polytope, 0, 1, 2),
    epa_face(polytope, 0, 3, 1),
    epa_face(polytope, 0, 2, 3),
    epa_face(polytope, 1, 3, 2),
  ];
  for (let iteration = 1; iteration <= 32; iteration++) {
    faces.sort((left, right) => left.distance - right.distance);
    const closest = faces[0];
    const point = minkowski_support(
      left_shape,
      left_pose,
      right_shape,
      right_pose,
      closest.normal,
    );
    const distance = vec3_dot(point, closest.normal);
    if (distance - closest.distance <= 1e-7) {
      const toward_right = vec3_subtract(
        right_pose.position,
        left_pose.position,
      );
      const normal = vec3_dot(closest.normal, toward_right) >= 0
        ? closest.normal
        : vec3_scale(closest.normal, -1);
      return Object.freeze({ normal, depth: distance, iterations: iteration });
    }
    const point_index = polytope.length;
    polytope.push(point);
    const visible = faces.filter((face) =>
      vec3_dot(
        face.normal,
        vec3_subtract(point, polytope[face.first]),
      ) > 1e-9
    );
    const boundary: [number, number][] = [];
    for (const face of visible) {
      for (
        const edge of [[face.first, face.second], [face.second, face.third], [
          face.third,
          face.first,
        ]] as const
      ) {
        const reverse = boundary.findIndex(([first, second]) =>
          first === edge[1] && second === edge[0]
        );
        if (reverse >= 0) boundary.splice(reverse, 1);
        else boundary.push([edge[0], edge[1]]);
      }
    }
    const visible_set = new Set(visible);
    faces = faces.filter((face) => !visible_set.has(face));
    for (const [first, second] of boundary) {
      faces.push(epa_face(polytope, first, second, point_index));
    }
  }
  return sat_penetration(left_shape, left_pose, right_shape, right_pose);
}

export function sat_penetration(
  left_shape: CollisionShape,
  left_pose: RigidPose,
  right_shape: CollisionShape,
  right_pose: RigidPose,
): PenetrationEstimate | null {
  const left_axes = pose_axes(left_pose);
  const right_axes = pose_axes(right_pose);
  const axes = [
    vec3(1, 0, 0),
    vec3(0, 1, 0),
    vec3(0, 0, 1),
    ...left_axes,
    ...right_axes,
    ...left_axes.flatMap((left) =>
      right_axes.map((right) => vec3_cross(left, right))
    ),
    vec3_subtract(right_pose.position, left_pose.position),
  ].filter((axis) => vec3_length_squared(axis) > 1e-18)
    .map(vec3_normalize);
  let depth = Infinity;
  let normal = axes[0];
  for (const axis of axes) {
    const left_maximum = vec3_dot(
      world_support(left_shape, left_pose, axis),
      axis,
    );
    const left_minimum = vec3_dot(
      world_support(left_shape, left_pose, vec3_scale(axis, -1)),
      axis,
    );
    const right_maximum = vec3_dot(
      world_support(right_shape, right_pose, axis),
      axis,
    );
    const right_minimum = vec3_dot(
      world_support(right_shape, right_pose, vec3_scale(axis, -1)),
      axis,
    );
    const overlap = Math.min(left_maximum, right_maximum) -
      Math.max(left_minimum, right_minimum);
    if (overlap <= 0) return null;
    if (overlap < depth) {
      depth = overlap;
      normal = axis;
    }
  }
  const toward_right = vec3_subtract(right_pose.position, left_pose.position);
  if (vec3_dot(normal, toward_right) < 0) normal = vec3_scale(normal, -1);
  return Object.freeze({ normal, depth, iterations: axes.length });
}

export function raycast_shape(
  cast: Ray,
  maximum_distance: number,
  shape: CollisionShape,
  pose: RigidPose,
): ShapeRayHit | null {
  if (shape.type === "sphere") {
    const hit = ray_sphere_intersection(
      cast,
      sphere(pose.position, shape.radius),
    );
    if (hit === null || hit.distance > maximum_distance) return null;
    return Object.freeze({
      distance: hit.distance,
      point: hit.position,
      normal: hit.normal,
    });
  }
  const hit = ray_aabb_intersection(
    cast,
    shape_world_bounds(shape, pose),
    maximum_distance,
  );
  if (hit === null) return null;
  return Object.freeze({
    distance: hit.distance,
    point: hit.position,
    normal: hit.normal,
  });
}

export function sweep_shape_bounds(
  moving_shape: CollisionShape,
  moving_pose: RigidPose,
  direction: Vec3,
  maximum_distance: number,
  target_shape: CollisionShape,
  target_pose: RigidPose,
): ShapeRayHit | null {
  const moving_bounds = shape_world_bounds(moving_shape, moving_pose);
  const center = vec3_scale(
    vec3_add(moving_bounds.minimum, moving_bounds.maximum),
    0.5,
  );
  const half_extents = vec3_scale(
    vec3_subtract(moving_bounds.maximum, moving_bounds.minimum),
    0.5,
  );
  const radius = Math.max(half_extents.x, half_extents.y, half_extents.z);
  const hit = sweep_sphere_aabb(
    sphere(center, Math.max(radius, 1e-9)),
    direction,
    maximum_distance,
    shape_world_bounds(target_shape, target_pose),
  );
  if (hit === null) return null;
  return Object.freeze({
    distance: hit.distance,
    point: hit.position,
    normal: hit.normal,
  });
}

export function closest_point_on_shape_bounds(
  point: Vec3,
  shape: CollisionShape,
  pose: RigidPose,
): Vec3 {
  if (shape.type === "sphere") {
    const offset = vec3_subtract(point, pose.position);
    const length = vec3_length(offset);
    if (length <= shape.radius) return point;
    return vec3_add(pose.position, vec3_scale(offset, shape.radius / length));
  }
  return closest_point_on_aabb(point, shape_world_bounds(shape, pose));
}

export function ray_from_displacement(origin: Vec3, displacement: Vec3): Ray {
  return ray(origin, vec3_normalize(displacement));
}

function sphere_contact(
  left_radius: number,
  left_center: Vec3,
  right_radius: number,
  right_center: Vec3,
): ContactGeometry | null {
  const offset = vec3_subtract(right_center, left_center);
  const distance = vec3_length(offset);
  const radius_sum = left_radius + right_radius;
  if (distance >= radius_sum) return null;
  const normal = distance === 0
    ? vec3(1, 0, 0)
    : vec3_scale(offset, 1 / distance);
  return Object.freeze({
    normal,
    point: vec3_add(
      left_center,
      vec3_scale(normal, left_radius - (radius_sum - distance) / 2),
    ),
    penetration: radius_sum - distance,
  });
}

function sphere_box_contact(
  radius: number,
  center: Vec3,
  box: Extract<CollisionShape, { type: "box" }>,
  box_pose: RigidPose,
): ContactGeometry | null {
  const inverse = quat_inverse(box_pose.rotation);
  const local_center = quat_rotate_vec3(
    inverse,
    vec3_subtract(center, box_pose.position),
  );
  const closest = vec3(
    Math.max(-box.half_extents.x, Math.min(box.half_extents.x, local_center.x)),
    Math.max(-box.half_extents.y, Math.min(box.half_extents.y, local_center.y)),
    Math.max(-box.half_extents.z, Math.min(box.half_extents.z, local_center.z)),
  );
  const local_offset = vec3_subtract(closest, local_center);
  const distance = vec3_length(local_offset);
  if (distance >= radius) return null;
  const local_normal = distance === 0
    ? interior_box_normal(local_center, box.half_extents)
    : vec3_scale(local_offset, 1 / distance);
  const normal = quat_rotate_vec3(box_pose.rotation, local_normal);
  return Object.freeze({
    normal,
    point: vec3_add(
      box_pose.position,
      quat_rotate_vec3(box_pose.rotation, closest),
    ),
    penetration: radius - distance,
  });
}

function sphere_concave_contact(
  radius: number,
  center: Vec3,
  shape: Extract<CollisionShape, { type: "heightfield" | "triangle_mesh" }>,
  pose: RigidPose,
): ContactGeometry | null {
  const local_center = quat_rotate_vec3(
    quat_inverse(pose.rotation),
    vec3_subtract(center, pose.position),
  );
  let closest: Vec3 | null = null;
  if (shape.type === "heightfield") {
    const grid_x = local_center.x / shape.spacing;
    const grid_z = local_center.z / shape.spacing;
    if (
      grid_x < 0 || grid_z < 0 || grid_x > shape.width - 1 ||
      grid_z > shape.depth - 1
    ) return null;
    const x = Math.min(Math.floor(grid_x), shape.width - 2);
    const z = Math.min(Math.floor(grid_z), shape.depth - 2);
    if (shape.holes[z * (shape.width - 1) + x] === 1) return null;
    const amount_x = grid_x - x;
    const amount_z = grid_z - z;
    const first = shape.heights[z * shape.width + x] * (1 - amount_x) +
      shape.heights[z * shape.width + x + 1] * amount_x;
    const second = shape.heights[(z + 1) * shape.width + x] * (1 - amount_x) +
      shape.heights[(z + 1) * shape.width + x + 1] * amount_x;
    closest = vec3(
      local_center.x,
      first * (1 - amount_z) + second * amount_z,
      local_center.z,
    );
  } else {
    let closest_distance = Infinity;
    for (
      let triangle_index = 0;
      triangle_index < shape.topology.triangle_count;
      triangle_index++
    ) {
      const offset = triangle_index * 3;
      const candidate = closest_point_on_triangle(
        local_center,
        triangle(
          shape.topology.positions[shape.topology.indices[offset]],
          shape.topology.positions[shape.topology.indices[offset + 1]],
          shape.topology.positions[shape.topology.indices[offset + 2]],
        ),
      );
      const distance = vec3_length_squared(
        vec3_subtract(candidate, local_center),
      );
      if (distance < closest_distance) {
        closest_distance = distance;
        closest = candidate;
      }
    }
  }
  if (closest === null) return null;
  const local_offset = vec3_subtract(closest, local_center);
  const distance = vec3_length(local_offset);
  if (distance >= radius) return null;
  const local_normal = distance === 0
    ? vec3(0, -1, 0)
    : vec3_scale(local_offset, 1 / distance);
  return Object.freeze({
    normal: quat_rotate_vec3(pose.rotation, local_normal),
    point: vec3_add(pose.position, quat_rotate_vec3(pose.rotation, closest)),
    penetration: radius - distance,
  });
}

function interior_box_normal(point: Vec3, extents: Vec3): Vec3 {
  const distances = [
    extents.x - Math.abs(point.x),
    extents.y - Math.abs(point.y),
    extents.z - Math.abs(point.z),
  ];
  const axis = distances[0] <= distances[1] && distances[0] <= distances[2]
    ? 0
    : distances[1] <= distances[2]
    ? 1
    : 2;
  if (axis === 0) return vec3(point.x >= 0 ? 1 : -1, 0, 0);
  if (axis === 1) return vec3(0, point.y >= 0 ? 1 : -1, 0);
  return vec3(0, 0, point.z >= 0 ? 1 : -1);
}

function aabb_contact(left: Aabb, right: Aabb): ContactGeometry | null {
  const overlaps = [
    Math.min(left.maximum.x, right.maximum.x) -
    Math.max(left.minimum.x, right.minimum.x),
    Math.min(left.maximum.y, right.maximum.y) -
    Math.max(left.minimum.y, right.minimum.y),
    Math.min(left.maximum.z, right.maximum.z) -
    Math.max(left.minimum.z, right.minimum.z),
  ];
  if (overlaps.some((overlap) => overlap <= 0)) return null;
  const left_center = vec3_scale(vec3_add(left.minimum, left.maximum), 0.5);
  const right_center = vec3_scale(vec3_add(right.minimum, right.maximum), 0.5);
  const axis = overlaps[0] <= overlaps[1] && overlaps[0] <= overlaps[2]
    ? 0
    : overlaps[1] <= overlaps[2]
    ? 1
    : 2;
  const normal = axis === 0
    ? vec3(right_center.x >= left_center.x ? 1 : -1, 0, 0)
    : axis === 1
    ? vec3(0, right_center.y >= left_center.y ? 1 : -1, 0)
    : vec3(0, 0, right_center.z >= left_center.z ? 1 : -1);
  return Object.freeze({
    normal,
    point: vec3(
      (Math.max(left.minimum.x, right.minimum.x) +
        Math.min(left.maximum.x, right.maximum.x)) / 2,
      (Math.max(left.minimum.y, right.minimum.y) +
        Math.min(left.maximum.y, right.maximum.y)) / 2,
      (Math.max(left.minimum.z, right.minimum.z) +
        Math.min(left.maximum.z, right.maximum.z)) / 2,
    ),
    penetration: overlaps[axis],
  });
}

function minkowski_support(
  left_shape: CollisionShape,
  left_pose: RigidPose,
  right_shape: CollisionShape,
  right_pose: RigidPose,
  direction: Vec3,
): Vec3 {
  const left = world_support(left_shape, left_pose, direction);
  const right = world_support(
    right_shape,
    right_pose,
    vec3_scale(direction, -1),
  );
  return vec3_subtract(left, right);
}

function world_support(
  shape: CollisionShape,
  pose: RigidPose,
  direction: Vec3,
): Vec3 {
  const local_direction = quat_rotate_vec3(
    quat_inverse(pose.rotation),
    direction,
  );
  return vec3_add(
    pose.position,
    quat_rotate_vec3(pose.rotation, shape_support(shape, local_direction)),
  );
}

interface EpaFace {
  readonly first: number;
  readonly second: number;
  readonly third: number;
  readonly normal: Vec3;
  readonly distance: number;
}

function epa_face(
  vertices: readonly Vec3[],
  first: number,
  second: number,
  third: number,
): EpaFace {
  let normal = vec3_normalize(
    vec3_cross(
      vec3_subtract(vertices[second], vertices[first]),
      vec3_subtract(vertices[third], vertices[first]),
    ),
  );
  let distance = vec3_dot(normal, vertices[first]);
  if (distance < 0) {
    normal = vec3_scale(normal, -1);
    distance = -distance;
    [second, third] = [third, second];
  }
  return Object.freeze({ first, second, third, normal, distance });
}

function tetrahedron_volume(vertices: readonly Vec3[]): number {
  if (vertices.length < 4) return 0;
  return Math.abs(
    vec3_dot(
      vec3_subtract(vertices[1], vertices[0]),
      vec3_cross(
        vec3_subtract(vertices[2], vertices[0]),
        vec3_subtract(vertices[3], vertices[0]),
      ),
    ),
  );
}

function pose_axes(pose: RigidPose): readonly Vec3[] {
  return [
    quat_rotate_vec3(pose.rotation, vec3(1, 0, 0)),
    quat_rotate_vec3(pose.rotation, vec3(0, 1, 0)),
    quat_rotate_vec3(pose.rotation, vec3(0, 0, 1)),
  ];
}

function update_simplex(
  simplex: Vec3[],
): { contains_origin: boolean; direction: Vec3 } {
  const a = simplex[0];
  const ao = vec3_scale(a, -1);
  if (simplex.length === 2) {
    const ab = vec3_subtract(simplex[1], a);
    if (vec3_dot(ab, ao) > 0) {
      return {
        contains_origin: false,
        direction: perpendicular_toward(ab, ao),
      };
    }
    simplex.splice(1);
    return { contains_origin: false, direction: ao };
  }
  if (simplex.length === 3) {
    const b = simplex[1];
    const c = simplex[2];
    const ab = vec3_subtract(b, a);
    const ac = vec3_subtract(c, a);
    const normal = vec3_cross(ab, ac);
    const ab_outside = vec3_cross(ab, normal);
    if (vec3_dot(ab_outside, ao) > 0) {
      simplex.splice(2);
      return {
        contains_origin: false,
        direction: perpendicular_toward(ab, ao),
      };
    }
    const ac_outside = vec3_cross(normal, ac);
    if (vec3_dot(ac_outside, ao) > 0) {
      simplex.splice(1, 1);
      return {
        contains_origin: false,
        direction: perpendicular_toward(ac, ao),
      };
    }
    if (vec3_dot(normal, ao) > 0) {
      return { contains_origin: false, direction: normal };
    }
    simplex[1] = c;
    simplex[2] = b;
    return { contains_origin: false, direction: vec3_scale(normal, -1) };
  }
  const b = simplex[1];
  const c = simplex[2];
  const d = simplex[3];
  const faces = [
    { points: [a, b, c] as const, remove: 3 },
    { points: [a, c, d] as const, remove: 1 },
    { points: [a, d, b] as const, remove: 2 },
  ];
  for (const face of faces) {
    let normal = vec3_cross(
      vec3_subtract(face.points[1], a),
      vec3_subtract(face.points[2], a),
    );
    const opposite = simplex[face.remove];
    if (vec3_dot(normal, vec3_subtract(opposite, a)) > 0) {
      normal = vec3_scale(normal, -1);
    }
    if (vec3_dot(normal, ao) > 0) {
      simplex.splice(face.remove, 1);
      return { contains_origin: false, direction: normal };
    }
  }
  return { contains_origin: true, direction: vec3(0, 0, 0) };
}

function perpendicular_toward(edge: Vec3, toward: Vec3): Vec3 {
  const perpendicular = vec3_cross(vec3_cross(edge, toward), edge);
  if (vec3_length_squared(perpendicular) > 1e-18) return perpendicular;
  return Math.abs(edge.x) < Math.abs(edge.y)
    ? vec3_cross(edge, vec3(1, 0, 0))
    : vec3_cross(edge, vec3(0, 1, 0));
}

function frozen_intersection(
  intersects: boolean,
  iterations: number,
  simplex: readonly Vec3[],
): ConvexIntersection {
  return Object.freeze({
    intersects,
    iterations,
    simplex: Object.freeze([...simplex]),
  });
}
