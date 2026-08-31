import type {
  VehicleCheckpoint,
  VehicleProject,
  VehicleWaypoint,
} from "@ink/vehicle-editor/model.ts";
import {
  parse_vehicle_project,
  serialize_vehicle_project,
} from "@ink/vehicle-editor/serialization.ts";
import {
  compile_vehicle_course_collision,
  type VehicleCourseCollisionContract,
} from "./course_collision.ts";

export interface CompiledVehicleProject {
  readonly blot_source: string;
  readonly canonical_source: string;
  readonly collision: VehicleCourseCollisionContract;
}

interface CompiledCheckpoint {
  readonly id: string;
  readonly waypoint_id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly speed_limit: number;
}

type AuthoredCourse =
  | {
    readonly type: "three_checkpoints";
    readonly first: CompiledCheckpoint;
    readonly second: CompiledCheckpoint;
    readonly third: CompiledCheckpoint;
  }
  | {
    readonly type: "four_checkpoints";
    readonly first: CompiledCheckpoint;
    readonly second: CompiledCheckpoint;
    readonly third: CompiledCheckpoint;
    readonly fourth: CompiledCheckpoint;
  };

export function compile_vehicle_project(
  source: string,
): CompiledVehicleProject {
  const project = parse_vehicle_project(source);
  if (project.objective.type !== "finish" || project.objective.laps !== 1) {
    throw new Error(
      `vehicle project ${project.id} objective ${project.objective.type} must be a one-lap finish`,
    );
  }
  const course = authored_course(project);
  const collision = compile_vehicle_course_collision(project);
  return Object.freeze({
    blot_source: compile_blot_project(project, course, collision),
    canonical_source: serialize_vehicle_project(project),
    collision,
  });
}

function authored_course(project: VehicleProject): AuthoredCourse {
  if (project.checkpoints.length !== 3 && project.checkpoints.length !== 4) {
    throw new Error(
      `vehicle project ${project.id} checkpoint count ${project.checkpoints.length} must be 3 or 4`,
    );
  }
  const first = compile_checkpoint(project, required_checkpoint(project, 0));
  const second = compile_checkpoint(project, required_checkpoint(project, 1));
  const third = compile_checkpoint(project, required_checkpoint(project, 2));
  if (project.checkpoints.length === 3) {
    return Object.freeze({
      type: "three_checkpoints",
      first,
      second,
      third,
    });
  }
  return Object.freeze({
    type: "four_checkpoints",
    first,
    second,
    third,
    fourth: compile_checkpoint(project, required_checkpoint(project, 3)),
  });
}

function required_checkpoint(
  project: VehicleProject,
  index: number,
): VehicleCheckpoint {
  const checkpoint = project.checkpoints[index];
  if (checkpoint === undefined) {
    throw new Error(
      `vehicle project ${project.id} has no checkpoint at index ${index}`,
    );
  }
  return checkpoint;
}

function compile_checkpoint(
  project: VehicleProject,
  checkpoint: VehicleCheckpoint,
): CompiledCheckpoint {
  const waypoint = project.waypoints.find(({ id }) =>
    id === checkpoint.waypoint_id
  );
  if (waypoint === undefined) {
    throw new Error(
      `vehicle checkpoint ${checkpoint.id} references missing waypoint ${checkpoint.waypoint_id}`,
    );
  }
  return Object.freeze({
    id: checkpoint.id,
    waypoint_id: waypoint.id,
    x: scaled_coordinate(waypoint, "x"),
    y: scaled_coordinate(waypoint, "y"),
    z: scaled_coordinate(waypoint, "z"),
    speed_limit: waypoint.speed_limit,
  });
}

function scaled_coordinate(
  waypoint: VehicleWaypoint,
  axis: keyof VehicleWaypoint["position"],
): number {
  const coordinate = Math.round(waypoint.position[axis] * 1_000_000);
  if (!Number.isSafeInteger(coordinate)) {
    throw new Error(
      `vehicle waypoint ${waypoint.id} ${axis} coordinate ${
        waypoint.position[axis]
      } cannot be represented in Blot fixed-point units`,
    );
  }
  return coordinate;
}

function compile_blot_project(
  project: VehicleProject,
  course: AuthoredCourse,
  collision: VehicleCourseCollisionContract,
): string {
  const fourth = course.type === "four_checkpoints"
    ? course.fourth
    : course.third;
  return `open import "blot:prelude"

const VehicleProject = {
  .runtime_token = Int;
  .project_id = Text;
  .project_name = Text;
  .vehicle_id = Text;
  .checkpoint_count = Int;
  .first_checkpoint_id = Text;
  .first_waypoint_id = Text;
  .first_x = Int;
  .first_y = Int;
  .first_z = Int;
  .first_speed_limit = Int;
  .second_checkpoint_id = Text;
  .second_waypoint_id = Text;
  .second_x = Int;
  .second_y = Int;
  .second_z = Int;
  .second_speed_limit = Int;
  .third_checkpoint_id = Text;
  .third_waypoint_id = Text;
  .third_x = Int;
  .third_y = Int;
  .third_z = Int;
  .third_speed_limit = Int;
  .fourth_checkpoint_id = Text;
  .fourth_waypoint_id = Text;
  .fourth_x = Int;
  .fourth_y = Int;
  .fourth_z = Int;
  .fourth_speed_limit = Int;
  .shortcut_barrier_contacts = Int;
  .shortcut_barrier_stop_x = Int;
  .shortcut_barrier_x = Int;
  .shortcut_barrier_y = Int;
  .shortcut_barrier_z = Int;
  .shortcut_barrier_width = Int;
  .shortcut_barrier_height = Int;
  .shortcut_barrier_depth = Int;
}

const project :: Int -> VehicleProject
const project = fn runtime_token => {
  .runtime_token = runtime_token;
  .project_id = ${blot_text_literal(project.id)};
  .project_name = ${blot_text_literal(project.name)};
  .vehicle_id = ${blot_text_literal(project.player_vehicle_id)};
  .checkpoint_count = ${course.type === "four_checkpoints" ? 4 : 3};
  .first_checkpoint_id = ${blot_text_literal(course.first.id)};
  .first_waypoint_id = ${blot_text_literal(course.first.waypoint_id)};
  .first_x = ${course.first.x};
  .first_y = ${course.first.y};
  .first_z = ${course.first.z};
  .first_speed_limit = ${course.first.speed_limit};
  .second_checkpoint_id = ${blot_text_literal(course.second.id)};
  .second_waypoint_id = ${blot_text_literal(course.second.waypoint_id)};
  .second_x = ${course.second.x};
  .second_y = ${course.second.y};
  .second_z = ${course.second.z};
  .second_speed_limit = ${course.second.speed_limit};
  .third_checkpoint_id = ${blot_text_literal(course.third.id)};
  .third_waypoint_id = ${blot_text_literal(course.third.waypoint_id)};
  .third_x = ${course.third.x};
  .third_y = ${course.third.y};
  .third_z = ${course.third.z};
  .third_speed_limit = ${course.third.speed_limit};
  .fourth_checkpoint_id = ${blot_text_literal(fourth.id)};
  .fourth_waypoint_id = ${blot_text_literal(fourth.waypoint_id)};
  .fourth_x = ${fourth.x};
  .fourth_y = ${fourth.y};
  .fourth_z = ${fourth.z};
  .fourth_speed_limit = ${fourth.speed_limit};
  .shortcut_barrier_contacts = ${collision.shortcut.contacts};
  .shortcut_barrier_stop_x = ${collision.shortcut.stop_x_microunits};
  .shortcut_barrier_x = ${collision.barrier.center_x_microunits};
  .shortcut_barrier_y = ${collision.barrier.center_y_microunits};
  .shortcut_barrier_z = ${collision.barrier.center_z_microunits};
  .shortcut_barrier_width = ${collision.barrier.width_microunits};
  .shortcut_barrier_height = ${collision.barrier.height_microunits};
  .shortcut_barrier_depth = ${collision.barrier.depth_microunits};
}

return { .project = project; }
`;
}

function blot_text_literal(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
