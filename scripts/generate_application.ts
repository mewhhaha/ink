import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ApplicationScenario,
  parse_application_scenario,
} from "./check_workspace.ts";

const workspace_directory = fileURLToPath(new URL("../", import.meta.url));
const common_dependencies = [
  "@ink/assets",
  "@ink/authoring",
  "@ink/blot",
  "@ink/development",
  "@ink/ecs",
  "@ink/editor-ui",
  "@ink/math",
  "@ink/observability",
  "@ink/runtime",
];

export function generated_application_files(
  application_path: string,
  scenario: ApplicationScenario,
): ReadonlyMap<string, string> {
  if (!/^apps\/[a-z][a-z0-9-]*-dev$/.test(application_path)) {
    throw new Error(
      `application path ${application_path} must match apps/<genre>-dev`,
    );
  }
  const application_name = application_path.slice("apps/".length);
  const editor_dependencies = scenario.editor === undefined
    ? []
    : [scenario.editor];
  const dependencies = Object.fromEntries(
    [...new Set([...common_dependencies, ...editor_dependencies])].sort().map((
      name,
    ) => [
      name,
      "workspace:*",
    ]),
  );
  const package_manifest = {
    name: `@ink/${application_name}`,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      build: "vite build",
      check:
        "deno check --config ../../deno.json src/main.tsx src/headless/main.ts src/browser/scenario_test.ts",
      dev: "vite",
      headless:
        "deno run --config ../../deno.json --allow-read src/headless/main.ts",
      test:
        "deno test --config ../../deno.json --allow-read src/headless/*_test.ts",
      "test:browser":
        "deno test --config ../../deno.json --allow-env --allow-net --allow-read --allow-run src/browser/*_test.ts",
    },
    dependencies: {
      ...dependencies,
      react: "catalog:",
      "react-dom": "catalog:",
    },
    devDependencies: {
      "@ink/vite": "workspace:*",
      "@types/react": "catalog:",
      "@types/react-dom": "catalog:",
      vite: "catalog:",
    },
    ink: { kind: "application" },
  };
  const title = application_name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

  return new Map([
    ["package.json", `${JSON.stringify(package_manifest, null, 2)}\n`],
    [
      "index.html",
      `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${title}</title>\n  </head>\n  <body>\n    <div id="application"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`,
    ],
    [
      "src/main.tsx",
      `import { mount_application } from "./application.tsx";\n\nconst application = document.getElementById("application");\nif (!(application instanceof HTMLElement)) {\n  throw new Error("${application_name} index is missing the application element");\n}\nmount_application(application);\n`,
    ],
    [
      "src/headless/main.ts",
      `import { run_headless_scenario } from "./scenario.ts";\n\nawait run_headless_scenario();\n`,
    ],
    [
      "src/browser/scenario_test.ts",
      `import { run_browser_scenario } from "./scenario.ts";\n\nDeno.test("${application_name} browser scenario proves its editor change", run_browser_scenario);\n`,
    ],
  ]);
}

async function run(): Promise<void> {
  const check_only = Deno.args.includes("--check");
  const positional_arguments = Deno.args.filter((argument) =>
    argument !== "--check"
  );
  if (positional_arguments.length !== 1) {
    throw new Error(
      "usage: generate_application.ts apps/<genre>-dev [--check]",
    );
  }
  const application_path = positional_arguments[0];
  if (application_path === undefined) {
    throw new Error("application path is required");
  }
  const application_directory = resolve(workspace_directory, application_path);
  const scenario_path = resolve(application_directory, "scenario.json");
  const scenario = parse_application_scenario(
    await Deno.readTextFile(scenario_path),
    scenario_path,
  );
  const changed_files: string[] = [];
  for (
    const [relative_path, expected_source] of generated_application_files(
      application_path,
      scenario,
    )
  ) {
    const path = resolve(application_directory, relative_path);
    let current_source: string | undefined;
    try {
      current_source = await Deno.readTextFile(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (current_source === expected_source) continue;
    changed_files.push(`${application_path}/${relative_path}`);
    if (check_only) continue;
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, expected_source);
  }

  if (check_only && changed_files.length > 0) {
    throw new Error(
      `generated application files differ: ${changed_files.join(", ")}`,
    );
  }
  const action = check_only ? "checked" : "generated";
  console.log(`${action} ${changed_files.length} application files`);
}

if (import.meta.main) await run();
