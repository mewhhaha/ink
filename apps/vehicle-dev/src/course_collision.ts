import type {
  VehicleProject,
  VehicleWaypoint,
} from "@ink/vehicle-editor/model.ts";
import { rigid_pose } from "@ink/physics/collision.ts";
import { physics_world_id, type ShapeId } from "@ink/physics/identity.ts";
import { box_shape } from "@ink/physics/shapes.ts";
import {
  type CharacterMoveResult,
  type PhysicsMutationResult,
  PhysicsWorld,
} from "@ink/physics/world.ts";
import { type Vec3, vec3 } from "@ink/math/vector.ts";

const microunits_per_meter = 1_000_000;
const vehicle_half_extents = vec3(1.5, 0.7, 0.9);
const shortcut_barrier_half_extents = vec3(0.8, 2, 2.5);

export interface VehicleCourseCollisionContract {
  readonly shortcut: {
    readonly type: "blocked";
    readonly stop_x_microunits: number;
    readonly stop_z_microunits: number;
    readonly contacts: number;
  };
  readonly ordered_course: {
    readonly type: "clear";
    readonly legs: number;
  };
  readonly barrier: {
    readonly center_x_microunits: number;
    readonly center_y_microunits: number;
    readonly center_z_microunits: number;
    readonly width_microunits: number;
    readonly height_microunits: number;
    readonly depth_microunits: number;
  };
}

export function compile_vehicle_course_collision(
  project: VehicleProject,
): VehicleCourseCollisionContract {
  const course = project.checkpoints.map((checkpoint) =>
    waypoint_position(project, checkpoint.waypoint_id)
  );
  const first = required_position(course, 0, project.id);
  const finish = required_position(course, course.length - 1, project.id);
  const staging = vec3(first.x - 8, first.y, first.z + 4);
  const barrier_center = vec3(
    (staging.x + finish.x) / 2,
    (staging.y + finish.y) / 2,
    (staging.z + finish.z) / 2,
  );
  const collision = collision_world(project.id, barrier_center);
  const shortcut = move_vehicle(
    collision.world,
    collision.vehicle_shape,
    staging,
    finish,
  );
  if (shortcut.contacts.length === 0 || reaches(shortcut, finish)) {
    throw new Error(
      `vehicle project ${project.id} finish shortcut stopped at (${shortcut.pose.position.x}, ${shortcut.pose.position.y}, ${shortcut.pose.position.z}) for target (${finish.x}, ${finish.y}, ${finish.z}) with ${shortcut.contacts.length} barrier contacts; expected one blocked route`,
    );
  }

  const ordered_positions = [staging, ...course];
  for (let index = 1; index < ordered_positions.length; index += 1) {
    const start = required_position(ordered_positions, index - 1, project.id);
    const target = required_position(ordered_positions, index, project.id);
    const leg = move_vehicle(
      collision.world,
      collision.vehicle_shape,
      start,
      target,
    );
    if (leg.contacts.length > 0 || !reaches(leg, target)) {
      throw new Error(
        `vehicle project ${project.id} ordered course leg ${index} stopped at (${leg.pose.position.x}, ${leg.pose.position.y}, ${leg.pose.position.z}) instead of (${target.x}, ${target.y}, ${target.z}) with ${leg.contacts.length} barrier contacts`,
      );
    }
  }

  return Object.freeze({
    shortcut: Object.freeze({
      type: "blocked",
      stop_x_microunits: to_microunits(shortcut.pose.position.x),
      stop_z_microunits: to_microunits(shortcut.pose.position.z),
      contacts: shortcut.contacts.length,
    }),
    ordered_course: Object.freeze({
      type: "clear",
      legs: course.length,
    }),
    barrier: Object.freeze({
      center_x_microunits: to_microunits(barrier_center.x),
      center_y_microunits: to_microunits(barrier_center.y),
      center_z_microunits: to_microunits(barrier_center.z),
      width_microunits: to_microunits(shortcut_barrier_half_extents.x * 2),
      height_microunits: to_microunits(shortcut_barrier_half_extents.y * 2),
      depth_microunits: to_microunits(shortcut_barrier_half_extents.z * 2),
    }),
  });
}

function collision_world(project_id: string, barrier_center: Vec3): {
  readonly world: PhysicsWorld;
  readonly vehicle_shape: ShapeId;
} {
  const world = new PhysicsWorld({
    id: physics_world_id(`vehicle-course-${project_id}`),
    fixed_step_seconds: 1 / 60,
    gravity: vec3(0, 0, 0),
  });
  const vehicle_shape = created(
    world.create_shape(box_shape(vehicle_half_extents)),
    `vehicle project ${project_id} vehicle shape`,
  );
  const barrier_shape = created(
    world.create_shape(box_shape(shortcut_barrier_half_extents)),
    `vehicle project ${project_id} shortcut barrier shape`,
  );
  const barrier_body = created(
    world.create_body({
      motion: "static",
      pose: rigid_pose(barrier_center),
    }),
    `vehicle project ${project_id} shortcut barrier body`,
  );
  created(
    world.create_collider({ body: barrier_body, shape: barrier_shape }),
    `vehicle project ${project_id} shortcut barrier collider`,
  );
  return Object.freeze({ world, vehicle_shape });
}

function move_vehicle(
  world: PhysicsWorld,
  vehicle_shape: Parameters<PhysicsWorld["move_character"]>[0]["shape"],
  start: Vec3,
  target: Vec3,
): CharacterMoveResult {
  return world.move_character({
    shape: vehicle_shape,
    pose: rigid_pose(start),
    displacement: vec3(
      target.x - start.x,
      target.y - start.y,
      target.z - start.z,
    ),
    step_height: 0,
    maximum_slope_radians: Math.PI / 4,
    skin: 0.01,
  });
}

function waypoint_position(
  project: VehicleProject,
  waypoint_id: VehicleWaypoint["id"],
): Vec3 {
  const waypoint = project.waypoints.find(({ id }) => id === waypoint_id);
  if (waypoint === undefined) {
    throw new Error(
      `vehicle project ${project.id} checkpoint references missing waypoint ${waypoint_id}`,
    );
  }
  return vec3(
    waypoint.position.x,
    waypoint.position.y + 0.9,
    waypoint.position.z,
  );
}

function required_position(
  positions: readonly Vec3[],
  index: number,
  project_id: string,
): Vec3 {
  const position = positions[index];
  if (position === undefined) {
    throw new Error(
      `vehicle project ${project_id} course has no position at index ${index}`,
    );
  }
  return position;
}

function reaches(move: CharacterMoveResult, target: Vec3): boolean {
  return Math.abs(move.pose.position.x - target.x) <= 1e-9 &&
    Math.abs(move.pose.position.y - target.y) <= 1e-9 &&
    Math.abs(move.pose.position.z - target.z) <= 1e-9;
}

function to_microunits(value: number): number {
  const scaled = Math.round(value * microunits_per_meter);
  if (!Number.isSafeInteger(scaled)) {
    throw new Error(
      `vehicle collision coordinate ${value} cannot be represented in microunits`,
    );
  }
  return scaled;
}

function created<Id>(
  result: PhysicsMutationResult<Id>,
  label: string,
): Id {
  if (result.type === "failed") {
    throw new Error(`${label} failed: ${result.reason}`);
  }
  return result.id;
}
