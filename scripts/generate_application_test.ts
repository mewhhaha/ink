import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type { ApplicationScenario } from "./check_workspace.ts";
import { generated_application_files } from "./generate_application.ts";

const scenario: ApplicationScenario = {
  version: 1,
  editor: "@ink/platformer-editor",
  stable_packages: ["@ink/input", "@ink/physics"],
  headless_command: "pnpm headless:platformer",
  browser_command: "pnpm test:browser:platformer",
  edit: "move the exit",
  expected_outcome: "the player reaches the moved exit",
};

Deno.test("application generation is limited to mechanical composition files", () => {
  const files = generated_application_files("apps/example-dev", scenario);
  assertEquals([...files.keys()], [
    "package.json",
    "index.html",
    "src/main.tsx",
    "src/headless/main.ts",
    "src/browser/scenario_test.ts",
  ]);
  const manifest = files.get("package.json");
  if (manifest === undefined) {
    throw new Error("generated package manifest is missing");
  }
  assertStringIncludes(manifest, '"@ink/platformer-editor": "workspace:*"');
  assertStringIncludes(manifest, '"kind": "application"');
  assertStringIncludes(
    files.get("src/main.tsx") ?? "",
    'from "./application.tsx"',
  );
  assertStringIncludes(
    files.get("index.html") ?? "",
    '<div id="application"></div>',
  );
});

Deno.test("application generation rejects paths outside the app workspace", () => {
  assertThrows(
    () => generated_application_files("packages/platformer-dev", scenario),
    Error,
    "must match apps/<genre>-dev",
  );
});
