import { assertEquals, assertThrows } from "@std/assert";
import {
  apply_roleplaying_command,
  create_roleplaying_starter_project,
  roleplaying_editor,
  validate_roleplaying_project,
} from "./index.ts";
Deno.test("role-playing catalog exposes focused tools and presets", () => {
  assertEquals(roleplaying_editor.tools.length, 7);
  assertEquals(roleplaying_editor.presets.length, 5);
});
Deno.test("role-playing commands preserve the source and validation accepts the starter", () => {
  const initial = create_roleplaying_starter_project();
  const changed = apply_roleplaying_command(initial, {
    type: "add_region",
    region: { id: "farm", label: "Farm" },
  });
  assertEquals(initial.regions.length, 2);
  assertEquals(changed.regions.length, 3);
  assertEquals(validate_roleplaying_project(initial), []);
  assertThrows(
    () =>
      apply_roleplaying_command(initial, {
        type: "add_region",
        region: initial.regions[0],
      }),
    Error,
    "repeats identity village",
  );
});
