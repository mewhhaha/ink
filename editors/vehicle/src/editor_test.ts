import { assertEquals, assertThrows } from "@std/assert";
import { vehicle_editor } from "./catalog.ts";
import { apply_vehicle_command } from "./commands.ts";
import {
  vehicle_archetype_id,
  vehicle_checkpoint_id,
  vehicle_hazard_id,
  vehicle_waypoint_id,
} from "./identity.ts";
import { vehicle_project } from "./model.ts";
import { create_vehicle_starter } from "./presets.ts";
import {
  parse_vehicle_project,
  serialize_vehicle_project,
} from "./serialization.ts";
import { validate_vehicle_project } from "./validation.ts";

Deno.test("vehicle editor exposes one command-owned operation for each creator tool", () => {
  assertEquals(vehicle_editor.tools.map(({ id }) => id), [
    "place-vehicle",
    "draw-course",
    "place-checkpoint",
    "place-hazard",
    "set-objective",
  ]);
});

Deno.test("submarine starters use a depth route and explicit hazard", () => {
  const project = create_vehicle_starter("submarine");
  assertEquals(validate_vehicle_project(project), []);
  assertEquals(project.waypoints[0].position.y, -20);
  assertEquals(project.hazards[0].kind, "depth");
});

Deno.test("vehicle commands append an ordered waypoint and checkpoint without mutation", () => {
  const source = create_vehicle_starter("racer");
  const extension_id = vehicle_waypoint_id("extension");
  let changed = apply_vehicle_command(source, {
    type: "set_player_vehicle",
    vehicle_id: vehicle_archetype_id("rally-car"),
  });
  changed = apply_vehicle_command(changed, {
    type: "append_waypoint",
    waypoint: {
      id: extension_id,
      position: { x: 140, y: 0, z: -20 },
      speed_limit: 16,
    },
  });
  changed = apply_vehicle_command(changed, {
    type: "append_checkpoint",
    checkpoint: {
      id: vehicle_checkpoint_id("checkpoint-extension"),
      waypoint_id: extension_id,
    },
  });
  changed = apply_vehicle_command(changed, {
    type: "add_hazard",
    hazard: {
      id: vehicle_hazard_id("extension-barrier"),
      waypoint_id: extension_id,
      kind: "obstacle",
    },
  });
  changed = apply_vehicle_command(changed, {
    type: "set_objective",
    objective: { type: "finish", laps: 1 },
  });
  assertEquals(source.waypoints.length, 3);
  assertEquals(changed.waypoints.at(-1)?.id, "extension");
  assertEquals(changed.checkpoints.map(({ waypoint_id }) => waypoint_id), [
    "start",
    "turn",
    "finish",
    "extension",
  ]);
  assertEquals(Object.isFrozen(changed.waypoints.at(-1)?.position), true);
  assertEquals(validate_vehicle_project(changed), []);
});

Deno.test("vehicle checkpoints cannot reverse the authored course order", () => {
  const starter = create_vehicle_starter("racer");
  const sparse = vehicle_project({
    ...starter,
    checkpoints: [starter.checkpoints[0], starter.checkpoints[2]],
  });
  assertEquals(validate_vehicle_project(sparse), []);
  assertThrows(
    () =>
      apply_vehicle_command(sparse, {
        type: "append_checkpoint",
        checkpoint: {
          id: vehicle_checkpoint_id("late-turn"),
          waypoint_id: vehicle_waypoint_id("turn"),
        },
      }),
    Error,
    "precedes checkpoint checkpoint-finish on the course",
  );
});

Deno.test("vehicle serialization round trips and reports unknown fields", () => {
  const serialized = serialize_vehicle_project(
    create_vehicle_starter("arcade-flight"),
  );
  assertEquals(
    serialize_vehicle_project(parse_vehicle_project(serialized)),
    serialized,
  );
  const unknown = JSON.parse(serialized);
  unknown.laps = 2;
  assertThrows(
    () => parse_vehicle_project(JSON.stringify(unknown), "course.json"),
    Error,
    "course.json fields differ; missing [], unknown [laps]",
  );
});

Deno.test("vehicle parsing rejects checkpoint order that reverses the course", () => {
  const malformed = JSON.parse(
    serialize_vehicle_project(create_vehicle_starter("racer")),
  );
  malformed.checkpoints.reverse();
  assertThrows(
    () => parse_vehicle_project(JSON.stringify(malformed), "course.json"),
    Error,
    "course.json is invalid: Checkpoint checkpoint-turn appears after a later course waypoint.",
  );
});
