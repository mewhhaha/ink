import type { VehicleArchetypeId } from "./identity.ts";
import {
  vehicle_project,
  type VehicleCheckpoint,
  type VehicleHazard,
  type VehicleObjective,
  type VehicleProject,
  type VehicleWaypoint,
} from "./model.ts";

export type VehicleCommand =
  | {
    readonly type: "set_player_vehicle";
    readonly vehicle_id: VehicleArchetypeId;
  }
  | { readonly type: "append_waypoint"; readonly waypoint: VehicleWaypoint }
  | {
    readonly type: "append_checkpoint";
    readonly checkpoint: VehicleCheckpoint;
  }
  | { readonly type: "add_hazard"; readonly hazard: VehicleHazard }
  | { readonly type: "set_objective"; readonly objective: VehicleObjective };

export function apply_vehicle_command(
  project: VehicleProject,
  command: VehicleCommand,
): VehicleProject {
  switch (command.type) {
    case "set_player_vehicle":
      return vehicle_project({
        ...project,
        player_vehicle_id: command.vehicle_id,
      });
    case "append_waypoint":
      require_unique(project.waypoints, command.waypoint.id, "waypoint");
      return vehicle_project({
        ...project,
        waypoints: [...project.waypoints, command.waypoint],
      });
    case "append_checkpoint": {
      require_unique(
        project.checkpoints,
        command.checkpoint.id,
        "checkpoint",
      );
      if (
        project.checkpoints.some(({ waypoint_id }) =>
          waypoint_id === command.checkpoint.waypoint_id
        )
      ) {
        throw new Error(
          `vehicle waypoint ${command.checkpoint.waypoint_id} already has a checkpoint`,
        );
      }
      const waypoint_index = project.waypoints.findIndex(({ id }) =>
        id === command.checkpoint.waypoint_id
      );
      if (waypoint_index < 0) {
        throw new Error(
          `vehicle checkpoint ${command.checkpoint.id} references missing waypoint ${command.checkpoint.waypoint_id}`,
        );
      }
      const previous = project.checkpoints.at(-1);
      if (previous !== undefined) {
        const previous_index = project.waypoints.findIndex(({ id }) =>
          id === previous.waypoint_id
        );
        if (waypoint_index <= previous_index) {
          throw new Error(
            `vehicle checkpoint ${command.checkpoint.id} waypoint ${command.checkpoint.waypoint_id} precedes checkpoint ${previous.id} on the course`,
          );
        }
      }
      return vehicle_project({
        ...project,
        checkpoints: [...project.checkpoints, command.checkpoint],
      });
    }
    case "add_hazard":
      require_unique(project.hazards, command.hazard.id, "hazard");
      if (
        !project.waypoints.some(({ id }) => id === command.hazard.waypoint_id)
      ) {
        throw new Error(
          `vehicle hazard ${command.hazard.id} references missing waypoint ${command.hazard.waypoint_id}`,
        );
      }
      return vehicle_project({
        ...project,
        hazards: [...project.hazards, command.hazard],
      });
    case "set_objective":
      return vehicle_project({ ...project, objective: command.objective });
  }
  const exhaustive: never = command;
  return exhaustive;
}

function require_unique(
  entries: readonly { readonly id: string }[],
  id: string,
  label: string,
): void {
  if (entries.some((entry) => entry.id === id)) {
    throw new Error(`vehicle ${label} repeats identity ${id}`);
  }
}
