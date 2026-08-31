import { apply_vehicle_command } from "@ink/vehicle-editor/commands.ts";
import {
  vehicle_checkpoint_id,
  vehicle_waypoint_id,
} from "@ink/vehicle-editor/identity.ts";
import type { VehicleProject } from "@ink/vehicle-editor/model.ts";

export function append_finish_checkpoint(
  project: VehicleProject,
): VehicleProject {
  const waypoint_id = vehicle_waypoint_id("finish-line");
  const with_waypoint = apply_vehicle_command(project, {
    type: "append_waypoint",
    waypoint: {
      id: waypoint_id,
      position: { x: 38, y: 1, z: -5 },
      speed_limit: 22,
    },
  });
  return apply_vehicle_command(with_waypoint, {
    type: "append_checkpoint",
    checkpoint: {
      id: vehicle_checkpoint_id("checkpoint-finish-line"),
      waypoint_id,
    },
  });
}
