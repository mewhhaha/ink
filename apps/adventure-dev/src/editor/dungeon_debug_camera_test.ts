import { assertEquals } from "@std/assert";
import {
  default_dungeon_debug_camera,
  dolly_dungeon_debug_camera,
  move_dungeon_debug_camera,
  orbit_dungeon_debug_camera,
  pan_dungeon_debug_camera,
} from "./dungeon_debug_camera.ts";

Deno.test("host debug camera orbit and pan stay within the readable dungeon view", () => {
  const orbited = orbit_dungeon_debug_camera(
    default_dungeon_debug_camera,
    50,
    -200,
  );
  assertEquals(orbited.yaw, 400_000);
  assertEquals(orbited.pitch, -1_350_000);

  const panned = pan_dungeon_debug_camera(orbited, 100, -50);
  assertEquals(panned.offset_x, 1_200_000);
  assertEquals(panned.offset_y, 600_000);
});

Deno.test("host debug camera dolly clamps both zoom limits", () => {
  assertEquals(
    dolly_dungeon_debug_camera(default_dungeon_debug_camera, -10_000).zoom,
    1_800_000,
  );
  assertEquals(
    dolly_dungeon_debug_camera(default_dungeon_debug_camera, 10_000).zoom,
    400_000,
  );
});

Deno.test("host debug camera movement flies continuously on camera-relative axes", () => {
  assertEquals(
    move_dungeon_debug_camera(
      { ...default_dungeon_debug_camera, yaw: 0 },
      { forward: 1, right: 0, vertical: 1 },
      50,
    ),
    {
      ...default_dungeon_debug_camera,
      yaw: 0,
      offset_y: -180_000,
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
