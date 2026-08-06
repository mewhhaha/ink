import { assertEquals } from "@std/assert";
import {
  connect_platformer_logic,
  place_platformer_record,
  remove_platformer_record,
} from "./commands.ts";
import {
  platformer_connection_id,
  platformer_layer_id,
  platformer_level_id,
  platformer_record_id,
} from "./identity.ts";
import { platformer_project, type PlatformerRecord } from "./model.ts";
import { create_platformer_starter } from "./starter.ts";
import { validate_platformer_project } from "./validation.ts";

const level_id = platformer_level_id("first-steps");
const gameplay_layer_id = platformer_layer_id("gameplay");

Deno.test("validation reports exact spawn and exit counts with creator recovery", () => {
  const without_spawn = remove_platformer_record(
    create_platformer_starter(),
    level_id,
    platformer_record_id("player-spawn"),
  );
  const spawn_failure = validate_platformer_project(without_spawn).find((
    { code },
  ) => code === "INVALID_SPAWN_COUNT");
  assertEquals(
    spawn_failure?.message,
    "Level first-steps has 0 player spawns; exactly one is required.",
  );
  assertEquals(
    spawn_failure?.recovery,
    "Keep exactly one player spawn in this level.",
  );

  const second_exit = place_platformer_record(
    create_platformer_starter(),
    { level_id, layer_id: gameplay_layer_id },
    {
      id: platformer_record_id("second-exit"),
      name: "Second exit",
      kind: "exit",
      bounds: { minimum: { x: 24, y: 2 }, maximum: { x: 26, y: 5 } },
      destination: { type: "complete" },
    },
  );
  assertEquals(codes(second_exit).includes("INVALID_EXIT_COUNT"), true);
});

Deno.test("validation accepts the complete platformer record vocabulary and connected logic", () => {
  let project = create_platformer_starter();
  const records: readonly PlatformerRecord[] = [{
    id: platformer_record_id("ramp"),
    name: "Ramp",
    kind: "slope",
    start: { x: 3, y: 2 },
    end: { x: 7, y: 5 },
    surface: "solid",
  }, {
    id: platformer_record_id("spikes"),
    name: "Spikes",
    kind: "hazard",
    bounds: { minimum: { x: 18, y: 2 }, maximum: { x: 20, y: 3 } },
    effect: { type: "defeat" },
  }, {
    id: platformer_record_id("midpoint"),
    name: "Midpoint",
    kind: "checkpoint",
    bounds: { minimum: { x: 13, y: 4 }, maximum: { x: 14, y: 7 } },
    respawn_position: { x: 13.5, y: 5 },
  }, {
    id: platformer_record_id("coin"),
    name: "Coin",
    kind: "collectible",
    position: { x: 8, y: 6 },
    collectible_key: "coin",
    quantity: 1,
  }, {
    id: platformer_record_id("slime"),
    name: "Slime",
    kind: "enemy",
    position: { x: 22, y: 2 },
    archetype: "slime",
    patrol_bounds: { minimum: { x: 21, y: 1 }, maximum: { x: 25, y: 4 } },
  }, {
    id: platformer_record_id("ground-route"),
    name: "Ground route",
    kind: "moving_path",
    platform_id: platformer_record_id("ground"),
    points: [{ x: 1, y: 1 }, { x: 4, y: 3 }],
    speed: 2,
    traversal: "ping_pong",
  }, {
    id: platformer_record_id("reveal-trigger"),
    name: "Reveal trigger",
    kind: "trigger_zone",
    bounds: { minimum: { x: 6, y: 2 }, maximum: { x: 9, y: 8 } },
    activation: "once",
  }, {
    id: platformer_record_id("close-camera"),
    name: "Close camera",
    kind: "camera_zone",
    bounds: { minimum: { x: 12, y: 2 }, maximum: { x: 18, y: 10 } },
    camera: {
      mode: "room",
      smoothing: 8,
      look_ahead: 0,
      dead_zone_width: 2,
      dead_zone_height: 2,
      vertical_tracking: 0.5,
    },
    priority: 1,
  }];
  for (const record of records) {
    project = place_platformer_record(
      project,
      { level_id, layer_id: gameplay_layer_id },
      record,
    );
  }
  project = connect_platformer_logic(project, level_id, {
    id: platformer_connection_id("reveal-route"),
    trigger: {
      record_id: platformer_record_id("reveal-trigger"),
      event: "entered",
    },
    condition: {
      type: "collectible_collected",
      collectible_id: platformer_record_id("coin"),
    },
    action: {
      type: "start_moving_path",
      path_id: platformer_record_id("ground-route"),
    },
  });
  assertEquals(validate_platformer_project(project), []);
});

Deno.test("validation identifies invalid bounds, paths, and kill planes without guessing a repair", () => {
  const starter = create_platformer_starter();
  let invalid = platformer_project({
    ...starter,
    levels: starter.levels.map((level) => ({
      ...level,
      kill_plane_y: 1,
    })),
  });
  invalid = place_platformer_record(
    invalid,
    { level_id, layer_id: gameplay_layer_id },
    {
      id: platformer_record_id("broken-route"),
      name: "Broken route",
      kind: "moving_path",
      platform_id: platformer_record_id("missing-platform"),
      points: [{ x: 40, y: 20 }],
      speed: 0,
      traversal: "cycle",
    },
  );
  assertEquals(
    new Set(codes(invalid)),
    new Set([
      "INVALID_KILL_PLANE",
      "RECORD_OUTSIDE_LEVEL",
      "ORPHAN_MOVING_PATH",
      "INVALID_MOVING_PATH",
      "INVALID_MOVING_PATH_SPEED",
    ]),
  );
});

Deno.test("removing a logic source exposes the orphaned connection", () => {
  const trigger_id = platformer_record_id("door-trigger");
  let project = place_platformer_record(
    create_platformer_starter(),
    { level_id, layer_id: gameplay_layer_id },
    {
      id: trigger_id,
      name: "Door trigger",
      kind: "trigger_zone",
      bounds: { minimum: { x: 3, y: 2 }, maximum: { x: 5, y: 6 } },
      activation: "repeat",
    },
  );
  assertEquals(codes(project), ["ORPHAN_TRIGGER_ZONE"]);
  project = connect_platformer_logic(project, level_id, {
    id: platformer_connection_id("open-exit"),
    trigger: { record_id: trigger_id, event: "entered" },
    condition: { type: "always" },
    action: {
      type: "enable_record",
      record_id: platformer_record_id("level-exit"),
    },
  });
  assertEquals(validate_platformer_project(project), []);
  const removed = remove_platformer_record(project, level_id, trigger_id);
  const orphan = validate_platformer_project(removed).find(({ code }) =>
    code === "ORPHAN_LOGIC_CONNECTION"
  );
  assertEquals(orphan?.subject, "connection:open-exit");
  assertEquals(
    orphan?.message.includes("trigger record door-trigger does not exist"),
    true,
  );
});

function codes(
  project: ReturnType<typeof create_platformer_starter>,
): string[] {
  return validate_platformer_project(project).map(({ code }) => code);
}
