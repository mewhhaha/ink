import { assertEquals } from "@std/assert";
import {
  default_dungeon_debug_camera,
  dolly_dungeon_debug_camera,
  dungeon_debug_camera_updates,
  move_dungeon_debug_camera,
  orbit_dungeon_debug_camera,
  pan_dungeon_debug_camera,
} from "./dungeon_debug_camera.ts";

Deno.test("debug camera orbit and pan stay within the readable dungeon view", () => {
  const orbited = orbit_dungeon_debug_camera(
    default_dungeon_debug_camera,
    50,
    -200,
  );
  assertEquals(orbited.yaw, 80_000);
  assertEquals(orbited.pitch, -1_350_000);

  const panned = pan_dungeon_debug_camera(orbited, 100, -50);
  assertEquals(panned.offset_x, 1_200_000);
  assertEquals(panned.offset_y, -300_000);
});

Deno.test("debug camera dolly clamps both zoom limits", () => {
  assertEquals(
    dolly_dungeon_debug_camera(default_dungeon_debug_camera, -10_000).zoom,
    1_800_000,
  );
  assertEquals(
    dolly_dungeon_debug_camera(default_dungeon_debug_camera, 10_000).zoom,
    400_000,
  );
});

Deno.test("debug camera movement flies continuously on camera-relative axes", () => {
  assertEquals(
    move_dungeon_debug_camera(
      { ...default_dungeon_debug_camera, yaw: 0 },
      { forward: 1, right: 0, vertical: 1 },
      50,
    ),
    {
      ...default_dungeon_debug_camera,
      yaw: 0,
      offset_y: -1_080_000,
      offset_z: 180_000,
    },
  );
  assertEquals(
    move_dungeon_debug_camera(
      { ...default_dungeon_debug_camera, yaw: 0 },
      { forward: 0, right: 1, vertical: 0 },
      50,
      3,
    ).offset_x,
    -540_000,
  );
});

Deno.test("debug camera updates encode every local render field", () => {
  const previous = {
    yaw: 0,
    pitch: 0,
    offset_x: 1,
    offset_y: 0,
    offset_z: 1,
    zoom: 1,
  };
  assertEquals(
    dungeon_debug_camera_updates(previous, default_dungeon_debug_camera),
    [
      { type: "custom", kind: 41, target: 0, value: 9_680_000 },
      { type: "custom", kind: 41, target: 1, value: 9_380_000 },
      { type: "custom", kind: 41, target: 2, value: 10_000_000 },
      { type: "custom", kind: 41, target: 3, value: 9_100_000 },
      { type: "custom", kind: 41, target: 4, value: 10_900_000 },
      { type: "custom", kind: 41, target: 5, value: 10_000_000 },
    ],
  );
});

Deno.test("unchanged debug camera fields produce no render updates", () => {
  assertEquals(
    dungeon_debug_camera_updates(
      default_dungeon_debug_camera,
      default_dungeon_debug_camera,
    ),
    [],
  );
});
