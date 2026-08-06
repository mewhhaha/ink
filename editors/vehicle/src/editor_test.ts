import { assertEquals, assertThrows } from "@std/assert";
import {
  append_vehicle_waypoint,
  create_vehicle_starter,
  validate_vehicle_project,
  vehicle_editor,
} from "./editor.ts";

Deno.test("vehicle editor exposes racer, flight, submarine, and space presets", () => {
  assertEquals(vehicle_editor.presets.map(({ id }) => id), [
    "racer",
    "arcade-flight",
    "submarine",
    "space-combat",
  ]);
});

Deno.test("submarine starters use a depth route and explicit hazard", () => {
  const project = create_vehicle_starter("submarine");
  assertEquals(validate_vehicle_project(project), []);
  assertEquals(project.waypoints[0].y, -20);
  assertEquals(project.hazards[0].kind, "depth");
});

Deno.test("vehicle course commands reject invalid waypoint speeds", () => {
  assertThrows(
    () =>
      append_vehicle_waypoint(create_vehicle_starter("racer"), {
        id: "bad",
        x: 0,
        y: 0,
        z: 0,
        speed_limit: 0,
      }),
    Error,
    "invalid position or speed",
  );
});
