import { type Quat, quat_rotate_vec3 } from "@ink/math/quaternion.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import { vec3, vec3_add } from "@ink/math/vector.ts";
import { compose_rigid_pose, shape_world_bounds } from "./collision.ts";
import { type BodyId, type ColliderId, physics_id_key } from "./identity.ts";
import type { BoxShape } from "./shapes.ts";
import type { PhysicsSnapshot } from "./world.ts";

export type PhysicsGizmoVisibility =
  | "all"
  | "none"
  | "collisions"
  | "areas";

export interface PhysicsGizmoLine {
  readonly start: Vec3;
  readonly finish: Vec3;
}

export interface CollisionGizmo {
  readonly collider: ColliderId;
  readonly body: BodyId;
  readonly category: "collision" | "area";
  readonly color: readonly [number, number, number, number];
  readonly lines: readonly PhysicsGizmoLine[];
}

const collision_color = Object.freeze([0.2, 1, 0.45, 1] as const);
const area_color = Object.freeze([1, 0.65, 0.15, 1] as const);

export function collision_gizmos(
  snapshot: PhysicsSnapshot,
  visibility: PhysicsGizmoVisibility,
): readonly CollisionGizmo[] {
  if (
    visibility !== "all" && visibility !== "none" &&
    visibility !== "collisions" && visibility !== "areas"
  ) {
    throw new Error(
      `physics gizmo visibility ${JSON.stringify(visibility)} is unsupported`,
    );
  }
  if (visibility === "none") return Object.freeze([]);
  const bodies = new Map(snapshot.bodies.map((body) => [
    physics_id_key(body.id),
    body,
  ]));
  const shapes = new Map(snapshot.shapes.map((shape) => [
    physics_id_key(shape.id),
    shape.shape,
  ]));
  const gizmos: CollisionGizmo[] = [];
  for (const collider of snapshot.colliders) {
    const category = collider.sensor ? "area" : "collision";
    if (visibility !== "all" && visibility !== `${category}s`) continue;
    const body = bodies.get(physics_id_key(collider.body));
    if (body === undefined) {
      throw new Error(
        `physics gizmo collider ${
          physics_id_key(collider.id)
        } references missing body ${physics_id_key(collider.body)}`,
      );
    }
    const shape = shapes.get(physics_id_key(collider.shape));
    if (shape === undefined) {
      throw new Error(
        `physics gizmo collider ${
          physics_id_key(collider.id)
        } references missing shape ${physics_id_key(collider.shape)}`,
      );
    }
    const pose = compose_rigid_pose(body.pose, collider.local_pose);
    gizmos.push(Object.freeze({
      collider: collider.id,
      body: collider.body,
      category,
      color: collider.sensor ? area_color : collision_color,
      lines: shape.type === "box"
        ? box_lines(shape, pose.position, pose.rotation)
        : bounds_lines(shape_world_bounds(shape, pose)),
    }));
  }
  return Object.freeze(gizmos);
}

function box_lines(
  shape: BoxShape,
  position: Vec3,
  rotation: Quat,
): readonly PhysicsGizmoLine[] {
  const corners = [
    vec3(-1, -1, -1),
    vec3(1, -1, -1),
    vec3(1, 1, -1),
    vec3(-1, 1, -1),
    vec3(-1, -1, 1),
    vec3(1, -1, 1),
    vec3(1, 1, 1),
    vec3(-1, 1, 1),
  ].map((corner) =>
    vec3_add(
      position,
      quat_rotate_vec3(
        rotation,
        vec3(
          corner.x * shape.half_extents.x,
          corner.y * shape.half_extents.y,
          corner.z * shape.half_extents.z,
        ),
      ),
    )
  );
  return indexed_lines(corners);
}

function bounds_lines(
  bounds: ReturnType<typeof shape_world_bounds>,
): readonly PhysicsGizmoLine[] {
  const { minimum, maximum } = bounds;
  return indexed_lines([
    vec3(minimum.x, minimum.y, minimum.z),
    vec3(maximum.x, minimum.y, minimum.z),
    vec3(maximum.x, maximum.y, minimum.z),
    vec3(minimum.x, maximum.y, minimum.z),
    vec3(minimum.x, minimum.y, maximum.z),
    vec3(maximum.x, minimum.y, maximum.z),
    vec3(maximum.x, maximum.y, maximum.z),
    vec3(minimum.x, maximum.y, maximum.z),
  ]);
}

function indexed_lines(corners: readonly Vec3[]): readonly PhysicsGizmoLine[] {
  const edges = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ] as const;
  return Object.freeze(
    edges.map(([start, finish]) =>
      Object.freeze({ start: corners[start], finish: corners[finish] })
    ),
  );
}
