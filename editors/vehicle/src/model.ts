import type { EditorPresetId } from "@ink/authoring/identity.ts";
import type {
  VehicleArchetypeId,
  VehicleCheckpointId,
  VehicleHazardId,
  VehicleProjectId,
  VehicleTargetId,
  VehicleWaypointId,
} from "./identity.ts";

export interface VehiclePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface VehicleWaypoint {
  readonly id: VehicleWaypointId;
  readonly position: VehiclePoint;
  readonly speed_limit: number;
}

export interface VehicleCheckpoint {
  readonly id: VehicleCheckpointId;
  readonly waypoint_id: VehicleWaypointId;
}

export interface VehicleHazard {
  readonly id: VehicleHazardId;
  readonly waypoint_id: VehicleWaypointId;
  readonly kind: "obstacle" | "weather" | "enemy" | "depth";
}

export type VehicleObjective =
  | { readonly type: "finish"; readonly laps: number }
  | { readonly type: "survive"; readonly duration_seconds: number }
  | {
    readonly type: "escort";
    readonly target_vehicle_id: VehicleArchetypeId;
  }
  | { readonly type: "destroy_target"; readonly target_id: VehicleTargetId };

export interface VehicleProject {
  readonly schema_version: 1;
  readonly id: VehicleProjectId;
  readonly name: string;
  readonly preset_id: EditorPresetId;
  readonly player_vehicle_id: VehicleArchetypeId;
  readonly waypoints: readonly VehicleWaypoint[];
  readonly checkpoints: readonly VehicleCheckpoint[];
  readonly hazards: readonly VehicleHazard[];
  readonly objective: VehicleObjective;
}

export function vehicle_project(project: VehicleProject): VehicleProject {
  return Object.freeze({
    schema_version: 1,
    id: project.id,
    name: required_text(project.name, `vehicle project ${project.id} name`),
    preset_id: project.preset_id,
    player_vehicle_id: project.player_vehicle_id,
    waypoints: Object.freeze(project.waypoints.map((waypoint) =>
      Object.freeze({
        id: waypoint.id,
        position: freeze_point(
          waypoint.position,
          `vehicle waypoint ${waypoint.id} position`,
        ),
        speed_limit: positive_number(
          waypoint.speed_limit,
          `vehicle waypoint ${waypoint.id} speed limit`,
        ),
      })
    )),
    checkpoints: Object.freeze(
      project.checkpoints.map((checkpoint) =>
        Object.freeze({
          id: checkpoint.id,
          waypoint_id: checkpoint.waypoint_id,
        })
      ),
    ),
    hazards: Object.freeze(project.hazards.map((hazard) =>
      Object.freeze({
        id: hazard.id,
        waypoint_id: hazard.waypoint_id,
        kind: hazard.kind,
      })
    )),
    objective: freeze_objective(project.objective),
  });
}

function freeze_objective(objective: VehicleObjective): VehicleObjective {
  switch (objective.type) {
    case "finish":
      return Object.freeze({
        type: objective.type,
        laps: positive_integer(objective.laps, "vehicle finish laps"),
      });
    case "survive":
      return Object.freeze({
        type: objective.type,
        duration_seconds: positive_number(
          objective.duration_seconds,
          "vehicle survival duration",
        ),
      });
    case "escort":
      return Object.freeze({
        type: objective.type,
        target_vehicle_id: objective.target_vehicle_id,
      });
    case "destroy_target":
      return Object.freeze({
        type: objective.type,
        target_id: objective.target_id,
      });
  }
  const exhaustive: never = objective;
  return exhaustive;
}

function freeze_point(point: VehiclePoint, label: string): VehiclePoint {
  return Object.freeze({
    x: finite_number(point.x, `${label} x`),
    y: finite_number(point.y, `${label} y`),
    z: finite_number(point.z, `${label} z`),
  });
}

function required_text(value: string, label: string): string {
  const text = value.trim();
  if (text.length === 0) throw new Error(`${label} must not be empty`);
  return text;
}

function finite_number(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} ${String(value)} must be finite`);
  }
  return value;
}

function positive_number(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} ${String(value)} must be positive`);
  }
  return value;
}

function positive_integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} ${String(value)} must be a positive integer`);
  }
  return value;
}
