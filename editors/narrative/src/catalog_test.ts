import { assertEquals } from "@std/assert";
import { narrative_editor } from "./catalog.ts";

Deno.test("narrative catalog exposes story tools and four focused presets", () => {
  assertEquals(narrative_editor.tools.length, 7);
  assertEquals(narrative_editor.presets.map(({ id }) => id), [
    "kinetic-novel",
    "branching-vn",
    "dating-sim",
    "investigation",
  ]);
});
