import { fileURLToPath } from "node:url";

export type InkProjectKind = "core" | "adapter" | "editor" | "application";

const workspace_location = new URL("../../", import.meta.url);
const workspace_directory = fileURLToPath(workspace_location);
const project_roots = ["apps", "editors", "packages"];

export function ink_project_kind(project_path: string): InkProjectKind {
  if (project_path.startsWith("apps/")) return "application";
  if (project_path.startsWith("editors/")) return "editor";
  if (project_path === "packages/blot" || project_path === "packages/vite") {
    return "adapter";
  }
  if (project_path.startsWith("packages/")) return "core";
  throw new Error(`cannot infer Ink project kind for ${project_path}`);
}

export function is_production_export(filename: string): boolean {
  if (!filename.endsWith(".ts") && !filename.endsWith(".tsx")) return false;
  if (filename.endsWith("_test.ts") || filename.endsWith("_test.tsx")) {
    return false;
  }
  if (filename.endsWith("_bench.ts") || filename.endsWith("_bench.tsx")) {
    return false;
  }
  return ![
    "legacy.ts",
    "migration.ts",
    "test_fixtures.ts",
  ].includes(filename);
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function project_directories(): Promise<string[]> {
  const directories: string[] = [];
  for (const root of project_roots) {
    for await (
      const directory_entry of Deno.readDir(`${workspace_directory}/${root}`)
    ) {
      if (!directory_entry.isDirectory) continue;
      const project_path = `${root}/${directory_entry.name}`;
      try {
        const manifest = await Deno.stat(
          `${workspace_directory}/${project_path}/package.json`,
        );
        if (manifest.isFile) directories.push(project_path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
    }
  }
  return directories.sort();
}

async function explicit_exports(
  project_path: string,
  current_exports: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const exports = { ...current_exports };
  for (const [subpath, target] of Object.entries(exports)) {
    if (typeof target !== "string" || !target.startsWith("./")) continue;
    const filename = target.split("/").at(-1);
    if (
      filename !== undefined &&
      (filename.endsWith(".ts") || filename.endsWith(".tsx")) &&
      !is_production_export(filename)
    ) {
      delete exports[subpath];
      continue;
    }
    try {
      const exported_file = await Deno.stat(
        `${workspace_directory}/${project_path}/${target}`,
      );
      if (!exported_file.isFile) delete exports[subpath];
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        delete exports[subpath];
        continue;
      }
      throw error;
    }
  }
  if ("./*.ts" in exports) {
    delete exports["./*.ts"];
    const source_directory = `${workspace_directory}/${project_path}/src`;
    for await (const directory_entry of Deno.readDir(source_directory)) {
      if (
        !directory_entry.isFile || !is_production_export(directory_entry.name)
      ) {
        continue;
      }
      exports[`./${directory_entry.name}`] = `./src/${directory_entry.name}`;
    }
  }
  if ("./*.blot" in exports) {
    delete exports["./*.blot"];
    const project_directory = `${workspace_directory}/${project_path}`;
    for await (const directory_entry of Deno.readDir(project_directory)) {
      if (!directory_entry.isFile || !directory_entry.name.endsWith(".blot")) {
        continue;
      }
      exports[`./${directory_entry.name}`] = `./${directory_entry.name}`;
    }
  }
  return Object.fromEntries(
    Object.entries(exports).sort(([left], [right]) =>
      left.localeCompare(right)
    ),
  );
}

async function synchronized_manifest(project_path: string): Promise<string> {
  const manifest_path = `${workspace_directory}/${project_path}/package.json`;
  const source = await Deno.readTextFile(manifest_path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`cannot parse ${manifest_path}: ${error}`);
  }
  if (!is_record(parsed)) {
    throw new Error(`${manifest_path} must contain an object`);
  }
  if (parsed.exports !== undefined && !is_record(parsed.exports)) {
    throw new Error(`${manifest_path} exports must be an object when declared`);
  }
  if (is_record(parsed.exports)) {
    parsed.exports = await explicit_exports(project_path, parsed.exports);
  }
  parsed.ink = { kind: ink_project_kind(project_path) };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function run(): Promise<void> {
  const unsupported_arguments = Deno.args.filter((argument) =>
    argument !== "--check"
  );
  if (unsupported_arguments.length > 0) {
    throw new Error(
      `unsupported workspace manifest arguments: ${
        unsupported_arguments.join(", ")
      }`,
    );
  }
  const check_only = Deno.args.includes("--check");
  const changed_projects: string[] = [];
  for (const project_path of await project_directories()) {
    const manifest_path = `${workspace_directory}/${project_path}/package.json`;
    const source = await Deno.readTextFile(manifest_path);
    const synchronized_source = await synchronized_manifest(project_path);
    if (source === synchronized_source) continue;
    changed_projects.push(project_path);
    if (!check_only) {
      await Deno.writeTextFile(manifest_path, synchronized_source);
    }
  }

  if (check_only && changed_projects.length > 0) {
    throw new Error(
      `workspace manifests are not synchronized: ${
        changed_projects.join(", ")
      }`,
    );
  }
  const action = check_only ? "checked" : "synchronized";
  console.log(`${action} ${changed_projects.length} workspace manifests`);
}

if (import.meta.main) await run();
