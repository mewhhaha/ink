import { apply_vehicle_command } from "@ink/vehicle-editor/commands.ts";
import {
  vehicle_checkpoint_id,
  vehicle_waypoint_id,
} from "@ink/vehicle-editor/identity.ts";
import {
  parse_vehicle_project,
  serialize_vehicle_project,
} from "@ink/vehicle-editor/serialization.ts";
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { append_finish_checkpoint } from "./edit.ts";
import { compile_vehicle_project } from "./project.ts";

const starter_file = new URL("../projects/starter.json", import.meta.url);

Deno.test("the vehicle compiler emits the appended finish checkpoint without mutating the starter", async () => {
  const source = await Deno.readTextFile(starter_file);
  const starter = parse_vehicle_project(source);
  const edited = append_finish_checkpoint(starter);
  const compiled = compile_vehicle_project(serialize_vehicle_project(edited));

  assertStringIncludes(compiled.blot_source, ".checkpoint_count = 4;");
  assertStringIncludes(
    compiled.blot_source,
    '.fourth_checkpoint_id = "checkpoint-finish-line";',
  );
  assertStringIncludes(
    compiled.blot_source,
    '.fourth_waypoint_id = "finish-line";',
  );
  assertStringIncludes(
    compiled.blot_source,
    ".shortcut_barrier_contacts = 1;",
  );
  assertStringIncludes(
    compiled.blot_source,
    "const project :: Int -> VehicleProject",
  );
  assertEquals(compiled.collision, {
    shortcut: {
      type: "blocked",
      stop_x_microunits: 690_501,
      stop_z_microunits: -5_000_000,
      contacts: 1,
    },
    ordered_course: {
      type: "clear",
      legs: 4,
    },
    barrier: {
      center_x_microunits: 3_000_000,
      center_y_microunits: 1_400_000,
      center_z_microunits: 6_500_000,
      width_microunits: 1_600_000,
      height_microunits: 4_000_000,
      depth_microunits: 5_000_000,
    },
  });
  assertEquals(starter.waypoints.map(({ id }) => id), [
    "start",
    "ridge",
    "tunnel",
  ]);
  assertEquals(Object.isFrozen(edited), true);
  assertEquals(Object.isFrozen(edited.waypoints), true);
});

Deno.test("the vehicle compiler rejects a fifth checkpoint outside the game contract", async () => {
  const starter = parse_vehicle_project(await Deno.readTextFile(starter_file));
  const edited = append_finish_checkpoint(starter);
  const waypoint_id = vehicle_waypoint_id("service-road");
  const with_waypoint = apply_vehicle_command(edited, {
    type: "append_waypoint",
    waypoint: {
      id: waypoint_id,
      position: { x: 50, y: 0, z: 4 },
      speed_limit: 8,
    },
  });
  const five_checkpoints = apply_vehicle_command(with_waypoint, {
    type: "append_checkpoint",
    checkpoint: {
      id: vehicle_checkpoint_id("checkpoint-service-road"),
      waypoint_id,
    },
  });
  assertThrows(
    () => compile_vehicle_project(serialize_vehicle_project(five_checkpoints)),
    Error,
    "checkpoint count 5 must be 3 or 4",
  );
});
