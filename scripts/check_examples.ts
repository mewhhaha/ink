import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace_directory = fileURLToPath(new URL("../", import.meta.url));
export const expected_examples = new Map([
  ["dungeon-dev", "@ink/dungeon-dev"],
  ["lighting-dev", "@ink/lighting-dev"],
  ["shrubbery-dev", "@ink/shrubbery-dev"],
  ["visual-novel-dev", "@ink/visual-novel-dev"],
]);

interface ExampleManifest {
  readonly name: string;
  readonly dependencies: Readonly<Record<string, unknown>>;
}

export function compare_example_names(
  actual_names: readonly string[],
): {
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
} {
  const actual = new Set(actual_names);
  return {
    missing: [...expected_examples.keys()].filter((name) => !actual.has(name)),
    unexpected: actual_names.filter((name) => !expected_examples.has(name)),
  };
}

async function run(): Promise<void> {
  const applications: string[] = [];
  for await (
    const entry of Deno.readDir(resolve(workspace_directory, "apps"))
  ) {
    if (entry.isDirectory) applications.push(entry.name);
  }
  applications.sort();
  const difference = compare_example_names(applications);
  if (difference.missing.length > 0 || difference.unexpected.length > 0) {
    throw new Error(
      `examples differ: missing [${
        difference.missing.join(", ")
      }], unexpected [${difference.unexpected.join(", ")}]`,
    );
  }

  for (const [directory_name, package_name] of expected_examples) {
    const directory = resolve(workspace_directory, "apps", directory_name);
    const manifest_path = resolve(directory, "package.json");
    const manifest = await read_example_manifest(manifest_path);
    if (manifest.name !== package_name) {
      throw new Error(
        `example ${directory_name} package is ${
          JSON.stringify(manifest.name)
        }, expected ${JSON.stringify(package_name)}`,
      );
    }
    const dependencies = manifest.dependencies;
    if (
      typeof dependencies !== "object" || dependencies === null ||
      dependencies["@ink/rendering"] !== "workspace:*"
    ) {
      throw new Error(`example ${package_name} must depend on @ink/rendering`);
    }
    const source = await application_source(directory);
    if (
      !source.includes("@ink/rendering/simple3d.ts") &&
      !source.includes("@ink/rendering/compatibility_renderer.ts")
    ) {
      throw new Error(
        `example ${package_name} does not import a stable WebGPU renderer`,
      );
    }
  }
  console.log("checked four focused 3D WebGPU examples");
}

async function read_example_manifest(path: string): Promise<ExampleManifest> {
  const parsed: unknown = JSON.parse(await Deno.readTextFile(path));
  if (!is_record(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    throw new Error(`${path} field name must be a non-empty string`);
  }
  if (!is_record(parsed.dependencies)) {
    throw new Error(`${path} field dependencies must be an object`);
  }
  return { name: parsed.name, dependencies: parsed.dependencies };
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function application_source(directory: string): Promise<string> {
  const source: string[] = [];
  const pending = [resolve(directory, "src")];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for await (const entry of Deno.readDir(current)) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory) {
        pending.push(path);
      } else if (entry.isFile && /\.(?:ts|tsx)$/.test(entry.name)) {
        source.push(await Deno.readTextFile(path));
      }
    }
  }
  return source.join("\n");
}

if (import.meta.main) await run();
