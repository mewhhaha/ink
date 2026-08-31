import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { fileURLToPath } from "node:url";
import {
  type ApplicationScenario,
  collect_scenario_coverage,
  dependency_direction_allowed,
  export_location_violations,
  package_export_subpath,
  parse_application_scenario,
  parse_package_exports,
  run_scenario_commands,
  type ScenarioCommandExecutor,
  type ScenarioCommandKind,
  type ScenarioReportBoundary,
  source_imports,
  unproved_stable_export_specifiers,
  workspace_proof_report,
  workspace_violations,
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

Deno.test("source imports include runtime edges and ignore non-runtime text", () => {
  assertEquals(
    source_imports(`
      import type { RuntimeSession } from "@ink/runtime/session.ts";
      import { type CameraId } from "@ink/camera/identity.ts";
      import "./styles.css";
      import { camera_id } from "@ink/camera/model.ts";
      import { type Vec2, vec2 } from "@ink/math/vector.ts";
      export { camera_id } from "@ink/camera/model.ts";
      export { type LightId } from "@ink/lighting/identity.ts";
      const guest = await import("@ink/blot/adapter.ts");
      // import "@ink/noise/hash.ts";
      const example = 'import "@ink/physics/world.ts"';
      const template = \`import "@ink/ui/browser.ts"\`;
      const matcher = /import\("@ink/noise/hash.ts"\)/u;
    `),
    [
      "./styles.css",
      "@ink/blot/adapter.ts",
      "@ink/camera/model.ts",
      "@ink/math/vector.ts",
    ],
  );
  assertEquals(package_export_subpath("@ink/physics", "@ink/physics"), ".");
  assertEquals(
    package_export_subpath("@ink/physics/world.ts", "@ink/physics"),
    "./world.ts",
  );
  assertEquals(
    package_export_subpath("@ink/physics-tools", "@ink/physics"),
    undefined,
  );
});

Deno.test("application scenarios parse complete executable proof", () => {
  assertEquals(
    parse_application_scenario(
      JSON.stringify({
        version: 2,
        role: "editor_game",
        editor: "@ink/adventure-editor",
        commands: {
          headless: "pnpm headless:adventure",
          browser: "pnpm test:browser:adventure",
        },
        edit: "place the oak gate",
        expected_outcome: "the player unlocks the gate",
        proofs: [{
          package: "@ink/physics",
          exports: ["./world.ts"],
          assertions: ["headless:gate-blocks-before-unlock"],
        }],
      }),
      "scenario.json",
    ),
    {
      version: 2,
      role: "editor_game",
      editor: "@ink/adventure-editor",
      commands: {
        headless: "pnpm headless:adventure",
        browser: "pnpm test:browser:adventure",
      },
      edit: "place the oak gate",
      expected_outcome: "the player unlocks the gate",
      proofs: [{
        package: "@ink/physics",
        exports: ["./world.ts"],
        assertions: ["headless:gate-blocks-before-unlock"],
      }],
    },
  );
  const renderer_scenario = parse_application_scenario(
    JSON.stringify({
      version: 2,
      role: "capability_demo",
      commands: { headless: "pnpm test", browser: "pnpm build" },
      edit: "change a light",
      expected_outcome: "the light changes",
      proofs: [{
        package: "@ink/rendering",
        exports: ["./renderer.ts"],
        assertions: ["browser:light-changes-pixels"],
      }],
    }),
    "scenario.json",
  );
  assertEquals(renderer_scenario.role, "capability_demo");
});

Deno.test("workspace proof reports list physical export stability and scenarios", async () => {
  const fixture_root = fileURLToPath(
    new URL("./test_fixtures/proof_workspace/", import.meta.url),
  );
  const report = await workspace_proof_report(fixture_root);
  assertEquals(report.version, 1);
  assertEquals(
    report.packages.map(({ name }) => name),
    ["@ink/proof-app", "@ink/proof-editor", "@ink/proof-core"],
  );
  const core = report.packages.find(({ name }) => name === "@ink/proof-core");
  assertEquals(core?.exports, [{
    subpath: "./behavior.ts",
    targets: ["./src/behavior.ts"],
    specifier: "@ink/proof-core/behavior.ts",
    stability: "stable",
  }, {
    subpath: "./guest.blot",
    targets: ["./src/guest.blot"],
    specifier: "@ink/proof-core/guest.blot",
    stability: "stable",
  }, {
    subpath: "./headless.ts",
    targets: ["./src/headless.ts"],
    specifier: "@ink/proof-core/headless.ts",
    stability: "stable",
  }, {
    subpath: "./experimental/hidden_experiment.ts",
    targets: ["./src/experimental/hidden_experiment.ts"],
    specifier: "@ink/proof-core/experimental/hidden_experiment.ts",
    stability: "experimental",
  }, {
    subpath: "./reachable.ts",
    targets: ["./src/reachable.ts"],
    specifier: "@ink/proof-core/reachable.ts",
    stability: "stable",
  }]);
  assertEquals(
    report.scenarios.map(({ application, scenario }) => ({
      application,
      role: scenario.role,
    })),
    [{ application: "@ink/proof-app", role: "editor_game" }],
  );
});

Deno.test("application scenarios reject obsolete, misplaced, and unowned fields", () => {
  assertThrows(
    () =>
      parse_application_scenario(
        JSON.stringify({
          version: 1,
          editor: "@ink/adventure-editor",
          stable_packages: ["@ink/runtime"],
          headless_command: "pnpm headless:adventure",
          browser_command: "pnpm dev:adventure",
          edit: "place the oak gate",
          expected_outcome: "the player unlocks the gate",
        }),
        "scenario.json",
      ),
    Error,
    "version 1 must be 2",
  );
  assertThrows(
    () =>
      parse_application_scenario(
        JSON.stringify({
          version: 2,
          role: "capability_demo",
          editor: "@ink/adventure-editor",
          commands: { headless: "pnpm test", browser: "pnpm build" },
          edit: "change a light",
          expected_outcome: "the light changes",
          proofs: [],
        }),
        "scenario.json",
      ),
    Error,
    '"editor"',
  );
  assertThrows(
    () =>
      parse_application_scenario(
        JSON.stringify({
          version: 2,
          role: "capability_demo",
          commands: { headless: "pnpm test", browser: "pnpm build" },
          edit: "change a light",
          expected_outcome: "the light changes",
          proofs: [{
            package: "@ink/rendering",
            exports: ["./renderer.ts"],
            assertions: ["light-changes-pixels"],
          }],
        }),
        "scenario.json",
      ),
    Error,
    '"light-changes-pixels" must begin with "browser:" or "headless:"',
  );
});

Deno.test("package export parsing preserves subpaths and conditional targets", () => {
  assertEquals(
    [...parse_package_exports({
      ".": "./src/index.ts",
      "./world.ts": {
        browser: "./src/browser_world.ts",
        default: "./src/world.ts",
      },
    }, "package.json")],
    [
      [".", ["./src/index.ts"]],
      ["./world.ts", ["./src/browser_world.ts", "./src/world.ts"]],
    ],
  );
  assertThrows(
    () =>
      parse_package_exports(
        { "world.ts": "../outside.ts" },
        "package.json",
      ),
    Error,
    'must be "." or begin with "./"',
  );
  assertThrows(
    () =>
      parse_package_exports(
        { "./world.ts": "../outside.ts" },
        "package.json",
      ),
    Error,
    'target "../outside.ts" must be a local path beginning with "./"',
  );
});

Deno.test("export namespaces and physical experimental paths agree", () => {
  assertEquals(
    export_location_violations(
      "@ink/physics",
      new Map([
        ["./world.ts", ["./src/world.ts"]],
        [
          "./experimental/adapters.ts",
          ["./src/experimental/adapters.ts"],
        ],
      ]),
    ),
    [],
  );
  assertEquals(
    export_location_violations(
      "@ink/physics",
      new Map([
        [
          "./experimental/normalized.ts",
          ["./src/experimental/../normalized.ts"],
        ],
        ["./experimental/world.ts", ["./src/world.ts"]],
        ["./adapters.ts", ["./src/experimental/adapters.ts"]],
        ["./normalized.ts", ["./src/internal/../experimental/normalized.ts"]],
      ]),
    ),
    [
      "export.experimental-location:@ink/physics/experimental/normalized.ts->./src/experimental/../normalized.ts",
      "export.experimental-location:@ink/physics/experimental/world.ts->./src/world.ts",
      "export.stable-location:@ink/physics/adapters.ts->./src/experimental/adapters.ts",
      "export.stable-location:@ink/physics/normalized.ts->./src/internal/../experimental/normalized.ts",
    ],
  );
});

Deno.test("test-only and unreachable production imports cannot prove a stable package export", async () => {
  const root = fileURLToPath(
    new URL("./test_fixtures/proof_workspace/", import.meta.url),
  );
  const boundary = command_test_boundary((kind) => ({
    version: 1,
    assertions: [{ id: `${kind}:behavior`, status: "passed" }],
  }));
  assertEquals(
    await workspace_violations({
      root,
      execute_scenario_command: boundary.execute,
      reports: boundary.reports,
    }),
    [
      "export.unproved:@ink/proof-core/behavior.ts",
      "import.experimental:scripts/test_fixtures/proof_workspace/editors/proof-editor/src/editor.ts:@ink/proof-core/experimental/hidden_experiment.ts",
      "scenario.export-unimported:@ink/proof-app->@ink/proof-core/behavior.ts",
    ],
  );
});

Deno.test("stable export coverage is exact and excludes physical experiments", () => {
  assertEquals(
    unproved_stable_export_specifiers(
      "@ink/physics",
      new Map([
        ["./world.ts", ["./src/world.ts"]],
        ["./world_2d.ts", ["./src/world_2d.ts"]],
        [
          "./experimental/adapters.ts",
          ["./src/experimental/adapters.ts"],
        ],
      ]),
      new Set(["./world.ts"]),
    ),
    ["@ink/physics/world_2d.ts"],
  );
});

const executable_scenario: ApplicationScenario = {
  version: 2,
  role: "editor_game",
  editor: "@ink/adventure-editor",
  commands: {
    headless: "pnpm headless:adventure",
    browser: "pnpm test:browser:adventure",
  },
  edit: "place the oak gate",
  expected_outcome: "the player unlocks the gate",
  proofs: [{
    package: "@ink/physics",
    exports: ["./world.ts"],
    assertions: [
      "headless:gate-blocks-before-unlock",
      "browser:gate-renders-open",
    ],
  }],
};

interface CommandTestBoundary {
  readonly execute: ScenarioCommandExecutor;
  readonly paths: readonly string[];
  readonly removed: readonly string[];
  readonly reports: ScenarioReportBoundary;
}

function command_test_boundary(
  report_for: (
    kind: ScenarioCommandKind,
  ) => unknown | undefined,
  result_for: (
    kind: ScenarioCommandKind,
  ) => {
    readonly code: number;
    readonly stderr: string;
    readonly stdout: string;
  } = () => ({ code: 0, stderr: "", stdout: "" }),
): CommandTestBoundary {
  const sources = new Map<string, string>();
  const paths: string[] = [];
  const removed: string[] = [];
  return {
    paths,
    removed,
    reports: {
      create_path(kind) {
        const path = `/scenario-reports/${paths.length}-${kind}.json`;
        paths.push(path);
        return Promise.resolve(path);
      },
      read(path) {
        const source = sources.get(path);
        if (source === undefined) {
          return Promise.reject(new Error(`missing test report ${path}`));
        }
        return Promise.resolve(source);
      },
      remove(path) {
        sources.delete(path);
        removed.push(path);
        return Promise.resolve();
      },
    },
    execute(request) {
      const report = report_for(request.kind);
      if (report !== undefined) {
        sources.set(request.report_path, JSON.stringify(report));
      }
      return Promise.resolve(result_for(request.kind));
    },
  };
}

Deno.test("scenario commands reconcile assertions and clean unique reports", async () => {
  const boundary = command_test_boundary((kind) => ({
    version: 1,
    assertions: kind === "headless"
      ? [{ id: "headless:gate-blocks-before-unlock", status: "passed" }]
      : [{ id: "browser:gate-renders-open", status: "passed" }],
  }));
  assertEquals(
    [
      ...await run_scenario_commands({
        scenario: executable_scenario,
        scenario_path: "apps/adventure-dev/scenario.json",
        working_directory: "apps/adventure-dev",
        execute: boundary.execute,
        reports: boundary.reports,
      }),
    ].sort(),
    ["browser:gate-renders-open", "headless:gate-blocks-before-unlock"],
  );
  assertEquals(new Set(boundary.paths).size, 2);
  assertEquals(boundary.removed, boundary.paths);
});

Deno.test("scenario commands reject a reused report path", async () => {
  const boundary = command_test_boundary((kind) => ({
    version: 1,
    assertions: kind === "headless"
      ? [{ id: "headless:gate-blocks-before-unlock", status: "passed" }]
      : [{ id: "browser:gate-renders-open", status: "passed" }],
  }));
  const reports: ScenarioReportBoundary = {
    ...boundary.reports,
    create_path: () => Promise.resolve("/scenario-reports/reused.json"),
  };
  await assertRejects(
    () =>
      run_scenario_commands({
        scenario: executable_scenario,
        scenario_path: "scenario.json",
        working_directory: "apps/adventure-dev",
        execute: boundary.execute,
        reports,
      }),
    Error,
    'reused scenario report path "/scenario-reports/reused.json"',
  );
  assertEquals(boundary.removed, [
    "/scenario-reports/reused.json",
    "/scenario-reports/reused.json",
  ]);
});

Deno.test("scenario commands reject unknown assertions", async () => {
  const unknown = command_test_boundary(() => ({
    version: 1,
    assertions: [{ id: "headless:unknown", status: "passed" }],
  }));
  await assertRejects(
    () =>
      run_scenario_commands({
        scenario: executable_scenario,
        scenario_path: "scenario.json",
        working_directory: "apps/adventure-dev",
        execute: unknown.execute,
        reports: unknown.reports,
      }),
    Error,
    'reported unknown assertion "headless:unknown"',
  );
});

Deno.test("scenario commands reject assertions reported by the wrong command", async () => {
  const boundary = command_test_boundary((kind) => ({
    version: 1,
    assertions: kind === "headless"
      ? [{ id: "browser:gate-renders-open", status: "passed" }]
      : [{
        id: "headless:gate-blocks-before-unlock",
        status: "passed",
      }],
  }));
  await assertRejects(
    () =>
      run_scenario_commands({
        scenario: executable_scenario,
        scenario_path: "scenario.json",
        working_directory: "apps/adventure-dev",
        execute: boundary.execute,
        reports: boundary.reports,
      }),
    Error,
    'headless command reported browser assertion "browser:gate-renders-open"',
  );
});

Deno.test("scenario commands reject failed and missing assertions", async () => {
  const failed = command_test_boundary((kind) => ({
    version: 1,
    assertions: kind === "headless"
      ? [{
        id: "headless:gate-blocks-before-unlock",
        status: "failed",
        reason: "gate did not block the player",
      }]
      : [],
  }));
  await assertRejects(
    () =>
      run_scenario_commands({
        scenario: executable_scenario,
        scenario_path: "scenario.json",
        working_directory: "apps/adventure-dev",
        execute: failed.execute,
        reports: failed.reports,
      }),
    Error,
    'assertion "headless:gate-blocks-before-unlock" failed: gate did not block the player',
  );

  const missing = command_test_boundary((kind) => ({
    version: 1,
    assertions: kind === "headless"
      ? [{ id: "headless:gate-blocks-before-unlock", status: "passed" }]
      : [],
  }));
  await assertRejects(
    () =>
      run_scenario_commands({
        scenario: executable_scenario,
        scenario_path: "scenario.json",
        working_directory: "apps/adventure-dev",
        execute: missing.execute,
        reports: missing.reports,
      }),
    Error,
    'did not report assertions ["browser:gate-renders-open"]',
  );
});

Deno.test("scenario commands reject absent reports and command failures", async () => {
  const absent = command_test_boundary(() => undefined);
  await assertRejects(
    () =>
      run_scenario_commands({
        scenario: executable_scenario,
        scenario_path: "scenario.json",
        working_directory: "apps/adventure-dev",
        execute: absent.execute,
        reports: absent.reports,
      }),
    Error,
    "did not write INK_SCENARIO_REPORT report",
  );
  assertEquals(absent.removed, [absent.paths[0]]);

  const command_failure = command_test_boundary(
    () => undefined,
    () => ({ code: 9, stderr: "compiler failed", stdout: "" }),
  );
  await assertRejects(
    () =>
      run_scenario_commands({
        scenario: executable_scenario,
        scenario_path: "scenario.json",
        working_directory: "apps/adventure-dev",
        execute: command_failure.execute,
        reports: command_failure.reports,
      }),
    Error,
    "exited with code 9: compiler failed",
  );
  assertEquals(command_failure.removed, [command_failure.paths[0]]);
});

Deno.test("scenario commands retain the scenario failure when cleanup also fails", async () => {
  const boundary = command_test_boundary(
    () => undefined,
    () => ({ code: 9, stderr: "compiler failed", stdout: "" }),
  );
  const reports: ScenarioReportBoundary = {
    ...boundary.reports,
    remove: (path) =>
      Promise.reject(new Error(`cannot remove test report ${path}`)),
  };
  const error = await assertRejects(
    () =>
      run_scenario_commands({
        scenario: executable_scenario,
        scenario_path: "scenario.json",
        working_directory: "apps/adventure-dev",
        execute: boundary.execute,
        reports,
      }),
    AggregateError,
    "headless command failed and could not remove scenario report",
  );
  assertEquals(error.errors.map(String), [
    'Error: scenario.json headless command "pnpm headless:adventure" exited with code 9: compiler failed',
    "Error: cannot remove test report /scenario-reports/0-headless.json",
  ]);
});

Deno.test("only valid editor games credit packages and every editor has one owner", () => {
  const capability_scenario: ApplicationScenario = {
    version: 2,
    role: "capability_demo",
    commands: { headless: "pnpm test", browser: "pnpm test:browser" },
    edit: "change a light",
    expected_outcome: "the rendered lighting changes",
    proofs: [{
      package: "@ink/rendering",
      exports: ["./renderer.ts"],
      assertions: ["browser:key-light-changes-pixels"],
    }],
  };
  const duplicate_owner: ApplicationScenario = {
    ...executable_scenario,
    proofs: [],
  };
  const coverage = collect_scenario_coverage(
    ["@ink/adventure-editor", "@ink/unowned-editor"],
    [
      {
        editor_wiring: "valid",
        scenario: executable_scenario,
        validated_exports: new Map([
          ["@ink/physics", new Set(["./world.ts"])],
        ]),
      },
      {
        editor_wiring: "valid",
        scenario: capability_scenario,
        validated_exports: new Map([
          ["@ink/rendering", new Set(["./renderer.ts"])],
        ]),
      },
      {
        editor_wiring: "invalid",
        scenario: duplicate_owner,
        validated_exports: new Map([
          ["@ink/navigation", new Set(["./query.ts"])],
        ]),
      },
    ],
  );
  assertEquals(
    [...coverage.proven_exports].map(([package_name, subpaths]) => [
      package_name,
      [...subpaths],
    ]),
    [["@ink/physics", ["./world.ts"]]],
  );
  assertEquals(coverage.owner_violations, [
    "editor.owner-count:@ink/adventure-editor=2",
    "editor.owner-count:@ink/unowned-editor=0",
  ]);
});
