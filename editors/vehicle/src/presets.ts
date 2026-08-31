import {
  vehicle_archetype_id,
  vehicle_checkpoint_id,
  vehicle_hazard_id,
  vehicle_project_id,
  vehicle_waypoint_id,
} from "./identity.ts";
import { vehicle_project, type VehicleProject } from "./model.ts";
import { vehicle_presets } from "./catalog.ts";

export function create_vehicle_starter(preset: string): VehicleProject {
  const selected = vehicle_presets.find(({ id }) => id === preset);
  if (selected === undefined) {
    throw new Error(`vehicle preset ${JSON.stringify(preset)} is unavailable`);
  }
  const depth = selected.id === "submarine" ? -20 : 0;
  const start_id = vehicle_waypoint_id("start");
  const turn_id = vehicle_waypoint_id("turn");
  const finish_id = vehicle_waypoint_id("finish");
  return vehicle_project({
    schema_version: 1,
    id: vehicle_project_id("starter-course"),
    name: `${selected.label} Starter`,
    preset_id: selected.id,
    player_vehicle_id: vehicle_archetype_id(
      selected.id === "submarine" ? "survey-submarine" : "starter-vehicle",
    ),
    waypoints: [
      {
        id: start_id,
        position: { x: 0, y: depth, z: 0 },
        speed_limit: 20,
      },
      {
        id: turn_id,
        position: { x: 50, y: depth, z: 35 },
        speed_limit: 12,
      },
      {
        id: finish_id,
        position: { x: 100, y: depth, z: 0 },
        speed_limit: 20,
      },
    ],
    checkpoints: [
      { id: vehicle_checkpoint_id("checkpoint-start"), waypoint_id: start_id },
      { id: vehicle_checkpoint_id("checkpoint-turn"), waypoint_id: turn_id },
      {
        id: vehicle_checkpoint_id("checkpoint-finish"),
        waypoint_id: finish_id,
      },
    ],
    hazards: selected.id === "submarine"
      ? [{
        id: vehicle_hazard_id("trench"),
        waypoint_id: turn_id,
        kind: "depth",
      }]
      : [],
    objective: { type: "finish", laps: selected.id === "racer" ? 3 : 1 },
  });
}
