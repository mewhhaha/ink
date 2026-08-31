import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type { ApplicationScenario } from "./check_workspace.ts";
import { generated_application_files } from "./generate_application.ts";

const scenario: ApplicationScenario = {
  version: 2,
  role: "editor_game",
  editor: "@ink/platformer-editor",
  commands: {
    headless: "pnpm headless:platformer",
    browser: "pnpm test:browser:platformer",
  },
  edit: "move the exit",
  expected_outcome: "the player reaches the moved exit",
  proofs: [{
    package: "@ink/physics",
    exports: ["./world_2d.ts"],
    assertions: ["headless:moved-exit-reached"],
  }],
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
  assertStringIncludes(manifest, '"@ink/physics": "workspace:*"');
  assertEquals(manifest.includes('"@ink/ecs"'), false);
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

Deno.test("capability demo generation has no editor dependency", () => {
  const capability_scenario: ApplicationScenario = {
    version: 2,
    role: "capability_demo",
    commands: {
      headless: "pnpm --filter @ink/lighting-dev test",
      browser: "pnpm --filter @ink/lighting-dev test:browser",
    },
    edit: "change the key light",
    expected_outcome: "the rendered lighting changes",
    proofs: [{
      package: "@ink/rendering",
      exports: ["./renderer.ts"],
      assertions: ["browser:key-light-changes-pixels"],
    }],
  };
  const manifest = generated_application_files(
    "apps/lighting-dev",
    capability_scenario,
  ).get("package.json");
  if (manifest === undefined) {
    throw new Error("generated package manifest is missing");
  }
  const dependencies = JSON.parse(manifest).dependencies as Record<
    string,
    string
  >;
  assertEquals(
    Object.keys(dependencies).filter((name) => name.endsWith("-editor")),
    [],
  );
});

Deno.test("application generation rejects paths outside the app workspace", () => {
  assertThrows(
    () => generated_application_files("packages/platformer-dev", scenario),
    Error,
    "must match apps/<genre>-dev",
  );
});
