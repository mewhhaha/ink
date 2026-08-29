import { assertEquals } from "@std/assert";
import { compare_example_names } from "./check_examples.ts";

Deno.test("example check reports missing and unexpected applications", () => {
  assertEquals(
    compare_example_names(["dungeon-dev", "lighting-dev", "old-dev"]),
    {
      missing: ["shrubbery-dev", "visual-novel-dev"],
      unexpected: ["old-dev"],
    },
  );
});
