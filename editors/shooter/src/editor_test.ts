import { assertEquals, assertThrows } from "@std/assert";
import {
  apply_shooter_command,
  create_shooter_starter_project,
  shooter_editor,
  validate_shooter_project,
} from "./index.ts";

Deno.test("shooter catalog exposes each genre creator tool and preset", () => {
  assertEquals(shooter_editor.tools.length, 7);
  assertEquals(shooter_editor.presets.map(({ id }) => id), [
    "boomer",
    "arena",
    "tactical",
    "horde",
    "immersive-sim",
  ]);
});
Deno.test("shooter starter project is playable and commands are immutable", () => {
  const initial = create_shooter_starter_project();
  const changed = apply_shooter_command(initial, {
    type: "add_room",
    room: { id: "exit", label: "Exit" },
  });
  assertEquals(initial.rooms.length, 2);
  assertEquals(changed.rooms.length, 3);
  assertEquals(validate_shooter_project(initial), []);
  assertThrows(
    () =>
      apply_shooter_command(initial, {
        type: "add_room",
        room: initial.rooms[0],
      }),
    Error,
    "repeats identity entry",
  );
});
