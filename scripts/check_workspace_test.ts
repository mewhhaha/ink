import { assertEquals, assertThrows } from "@std/assert";
import {
  compare_architecture_debt,
  dependency_direction_allowed,
  parse_application_scenario,
  source_imports,
} from "./check_workspace.ts";

Deno.test("dependency direction follows the four workspace layers", () => {
  assertEquals(dependency_direction_allowed("core", "core"), true);
  assertEquals(dependency_direction_allowed("core", "adapter"), false);
  assertEquals(dependency_direction_allowed("adapter", "core"), true);
  assertEquals(dependency_direction_allowed("editor", "core"), true);
  assertEquals(dependency_direction_allowed("application", "editor"), true);
  assertEquals(
    dependency_direction_allowed("application", "application"),
    false,
  );
});

Deno.test("source imports include static, side-effect, export, and dynamic forms", () => {
  assertEquals(
    source_imports(`
      import type { RuntimeSession } from "@ink/runtime/session.ts";
      import "./styles.css";
      export { camera_id } from "@ink/camera/model.ts";
      const guest = await import("@ink/blot/adapter.ts");
    `),
    [
      "./styles.css",
      "@ink/blot/adapter.ts",
      "@ink/camera/model.ts",
      "@ink/runtime/session.ts",
    ],
  );
});

Deno.test("application scenarios parse complete executable proof", () => {
  assertEquals(
    parse_application_scenario(
      JSON.stringify({
        version: 1,
        editor: "@ink/adventure-editor",
        stable_packages: ["@ink/runtime"],
        headless_command: "pnpm headless:adventure",
        browser_command: "pnpm test:browser:adventure",
        edit: "place the oak gate",
        expected_outcome: "the player unlocks the gate",
      }),
      "scenario.json",
    ),
    {
      version: 1,
      editor: "@ink/adventure-editor",
      stable_packages: ["@ink/runtime"],
      headless_command: "pnpm headless:adventure",
      browser_command: "pnpm test:browser:adventure",
      edit: "place the oak gate",
      expected_outcome: "the player unlocks the gate",
    },
  );
  assertThrows(
    () =>
      parse_application_scenario(
        JSON.stringify({ version: 1, stable_packages: [] }),
        "scenario.json",
      ),
    Error,
    "field editor",
  );
});

Deno.test("architecture debt comparison rejects new and resolved violations", () => {
  assertEquals(
    compare_architecture_debt(
      ["dependency.direction:a->b", "scenario.missing:a"],
      ["dependency.direction:a->b", "export.wildcard:b"],
    ),
    {
      unexpected: ["scenario.missing:a"],
      stale: ["export.wildcard:b"],
    },
  );
});
