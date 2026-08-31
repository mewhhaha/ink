import { assertEquals, assertThrows } from "@std/assert";
import { parse_capability_scenario_command } from "./run_capability_scenario_command.ts";

Deno.test("capability scenario commands parse the invoked command", () => {
  assertEquals(
    parse_capability_scenario_command([
      "--",
      "pnpm",
      "test",
      "--filter",
      "scene",
    ]),
    {
      executable: "pnpm",
      arguments: ["test", "--filter", "scene"],
    },
  );
});

Deno.test("capability scenario commands reject proof assertions", () => {
  assertThrows(
    () =>
      parse_capability_scenario_command([
        "--passed",
        "browser:scene-renders",
        "--",
        "pnpm",
        "test",
      ]),
    Error,
    "capability demos cannot declare proof assertions",
  );
});

Deno.test("capability scenario commands reject a missing executable", () => {
  assertThrows(
    () => parse_capability_scenario_command(["--"]),
    Error,
    "executable undefined",
  );
});
