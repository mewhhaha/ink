import { assertEquals, assertThrows } from "@std/assert";
import { draw_strategy_route, schedule_strategy_wave } from "./commands.ts";
import { create_strategy_starter, strategy_editor } from "./presets.ts";
import { validate_strategy_project } from "./validation.ts";

Deno.test("strategy editor exposes five focused subgenre presets", () => {
  assertEquals(strategy_editor.presets.map(({ id }) => id), [
    "tower-defense",
    "real-time-strategy",
    "tactics",
    "city-builder",
    "automation",
  ]);
});

Deno.test("strategy starters open with factions, a route, a wave, and a visible objective", () => {
  const project = create_strategy_starter("tower-defense");
  assertEquals(validate_strategy_project(project), []);
  assertEquals(project.factions.length, 2);
  assertEquals(project.objectives[0].condition, "destroy-target");
});

Deno.test("strategy commands connect authored routes to scheduled waves", () => {
  let project = create_strategy_starter("real-time-strategy");
  project = draw_strategy_route(project, {
    id: "flank",
    points: [{ x: 2, y: 2 }, { x: 20, y: 14 }],
  });
  project = schedule_strategy_wave(project, {
    id: "flank-wave",
    route: "flank",
    faction: "opponent",
    unit: "raider",
    count: 6,
    starts_at_seconds: 12,
  });
  assertEquals(project.waves.at(-1)?.route, "flank");
});

Deno.test("strategy commands reject waves whose creator route is missing", () => {
  assertThrows(
    () =>
      schedule_strategy_wave(create_strategy_starter("tactics"), {
        id: "bad-wave",
        route: "missing",
        faction: "opponent",
        unit: "scout",
        count: 1,
        starts_at_seconds: 0,
      }),
    Error,
    "missing route missing",
  );
});
