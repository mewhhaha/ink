import type {
  PlatformerBounds,
  PlatformerProject,
} from "@ink/platformer-editor/model.ts";
import { rigid_pose } from "@ink/physics/collision.ts";
import {
  type BodyId,
  type ColliderId,
  physics_id_equal,
  physics_world_id,
  type ShapeId,
} from "@ink/physics/identity.ts";
import { box_shape } from "@ink/physics/shapes.ts";
import { PhysicsWorld } from "@ink/physics/world.ts";
import { box_shape_2d, CollisionWorld2d } from "@ink/physics/world_2d.ts";
import type { Vec2 } from "@ink/math/vector.ts";
import { vec2, vec3 } from "@ink/math/vector.ts";
import type { Observer } from "@ink/observability/observer.ts";

export interface PlatformerCollisionOracle {
  readonly player_overlaps_exit: (center: Vec2) => boolean;
  readonly support_distance: (
    center: Vec2,
    maximum_distance: number,
  ) => number | undefined;
}

export function create_platformer_collision_oracle(
  project: PlatformerProject,
  observer: Observer,
): PlatformerCollisionOracle {
  const level = project.levels.find(({ id }) => id === project.entry_level_id);
  if (level === undefined) {
    throw new Error(
      `platformer project ${project.id} entry level ${project.entry_level_id} is missing`,
    );
  }
  const records = level.layers.flatMap(({ records }) => records);
  const exit = records.find((record) => record.kind === "exit");
  if (exit === undefined) {
    throw new Error(`platformer level ${level.id} has no exit record`);
  }
  const platforms = records.filter((record) => record.kind === "platform");
  if (platforms.length === 0) {
    throw new Error(`platformer level ${level.id} has no collision platforms`);
  }

  const world = new CollisionWorld2d({
    id: physics_world_id(`platformer-oracle:${project.id}`),
    fixed_step_seconds: 1 / 60,
    observer,
  });
  const reference_world = new PhysicsWorld({
    id: physics_world_id(`platformer-reference:${project.id}`),
    fixed_step_seconds: 1 / 60,
    gravity: vec3(0, 0, 0),
    observer,
  });
  const player_shape = created(
    world.create_shape(box_shape_2d(vec2(0.4, 0.75))),
    `platformer project ${project.id} player shape`,
  );
  const reference_player_shape = created(
    reference_world.create_shape(box_shape(vec3(0.4, 0.75, 0.5))),
    `platformer project ${project.id} reference player shape`,
  );
  for (const platform of platforms) {
    const platform_half_extents = half_extents(platform.bounds);
    const shape = created(
      world.create_shape(box_shape_2d(platform_half_extents)),
      `platform ${platform.id} shape`,
    );
    created(
      world.create_collision({
        shape,
        position: bounds_center(platform.bounds),
      }),
      `platform ${platform.id} collision`,
    );
    const reference_shape = created(
      reference_world.create_shape(box_shape(vec3(
        platform_half_extents.x,
        platform_half_extents.y,
        0.5,
      ))),
      `platform ${platform.id} reference shape`,
    );
    const reference_body = created(
      reference_world.create_body({
        motion: "kinematic",
        pose: pose_3d(bounds_center(platform.bounds)),
      }),
      `platform ${platform.id} reference body`,
    );
    created(
      reference_world.create_collider({
        body: reference_body,
        shape: reference_shape,
      }),
      `platform ${platform.id} reference collision`,
    );
  }
  const exit_shape = created(
    world.create_shape(box_shape_2d(half_extents(exit.bounds))),
    `exit ${exit.id} shape`,
  );
  const exit_area = created(
    world.create_area({
      shape: exit_shape,
      position: bounds_center(exit.bounds),
    }),
    `exit ${exit.id} area`,
  );
  const exit_half_extents = half_extents(exit.bounds);
  const reference_exit_shape = created(
    reference_world.create_shape(box_shape(vec3(
      exit_half_extents.x,
      exit_half_extents.y,
      0.5,
    ))),
    `exit ${exit.id} reference shape`,
  );
  const reference_exit_body = created(
    reference_world.create_body({
      motion: "kinematic",
      pose: pose_3d(bounds_center(exit.bounds)),
    }),
    `exit ${exit.id} reference body`,
  );
  const reference_exit_area = created(
    reference_world.create_area({
      body: reference_exit_body,
      shape: reference_exit_shape,
    }),
    `exit ${exit.id} reference area`,
  );

  return Object.freeze({
    player_overlaps_exit(center: Vec2) {
      const overlaps_exit = world.overlap_shape(
        player_shape,
        { position: center },
        { include_areas: true },
      ).some((collision) => physics_id_equal(collision, exit_area));
      const reference_overlaps_exit = reference_world.overlap_shape(
        reference_player_shape,
        pose_3d(center),
        { include_sensors: true },
      ).some((collision) => physics_id_equal(collision, reference_exit_area));
      if (overlaps_exit !== reference_overlaps_exit) {
        throw new Error(
          `platformer exit overlap disagreed between 2D and reference worlds at (${center.x}, ${center.y})`,
        );
      }
      return overlaps_exit;
    },
    support_distance(center: Vec2, maximum_distance: number) {
      const distance = world.shape_cast(
        player_shape,
        { position: center },
        vec2(0, -1),
        maximum_distance,
      ).at(0)?.distance;
      const reference_distance = reference_world.shape_cast(
        reference_player_shape,
        pose_3d(center),
        vec3(0, -1, 0),
        maximum_distance,
      ).at(0)?.distance;
      if (distance !== reference_distance) {
        throw new Error(
          `platformer support distance disagreed between 2D ${
            String(distance)
          } and reference ${String(reference_distance)}`,
        );
      }
      return distance;
    },
  });
}

function pose_3d(center: Vec2) {
  return rigid_pose(vec3(center.x, center.y, 0));
}

function half_extents(bounds: PlatformerBounds): Vec2 {
  return vec2(
    (bounds.maximum.x - bounds.minimum.x) / 2,
    (bounds.maximum.y - bounds.minimum.y) / 2,
  );
}

function bounds_center(bounds: PlatformerBounds): Vec2 {
  return vec2(
    (bounds.minimum.x + bounds.maximum.x) / 2,
    (bounds.minimum.y + bounds.maximum.y) / 2,
  );
}

function created<Id extends ShapeId | BodyId | ColliderId>(
  result:
    | { readonly type: "created"; readonly id: Id }
    | { readonly type: "failed"; readonly reason: string },
  label: string,
): Id {
  if (result.type === "failed") {
    throw new Error(`${label} failed: ${result.reason}`);
  }
  return result.id;
}
