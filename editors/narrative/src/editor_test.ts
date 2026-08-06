import { assertEquals, assertThrows } from "@std/assert";
import {
  apply_narrative_command,
  create_narrative_starter_project,
  narrative_editor,
  validate_narrative_project,
} from "./index.ts";
Deno.test("narrative catalog exposes story tools and four presets", () => {
  assertEquals(narrative_editor.tools.length, 7);
  assertEquals(narrative_editor.presets.map(({ id }) => id), [
    "kinetic-novel",
    "branching-vn",
    "dating-sim",
    "investigation",
  ]);
});
Deno.test("narrative starter branches cleanly and commands retain its source", () => {
  const initial = create_narrative_starter_project();
  const changed = apply_narrative_command(initial, {
    type: "add_variable",
    variable: { id: "courage", initial: 1 },
  });
  assertEquals(initial.variables.length, 1);
  assertEquals(changed.variables.length, 2);
  assertEquals(validate_narrative_project(initial), []);
  assertThrows(
    () =>
      apply_narrative_command(initial, {
        type: "add_variable",
        variable: initial.variables[0],
      }),
    Error,
    "repeats identity trust",
  );
});
