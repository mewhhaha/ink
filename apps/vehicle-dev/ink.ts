import {
  build_blot_game,
  create_blot_development_build,
  create_serial_blot_project_publisher,
} from "@ink/blot/build.ts";
import { define_ink_application } from "@ink/vite";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { game_adapter } from "./src/game_adapter.ts";
import { compile_vehicle_project } from "./src/project.ts";

const application_directory = new URL("./", import.meta.url);
const project_file = configured_project_file();
const project_manifest = new URL("blot.json", application_directory);
const provider_file = new URL(
  "src/blot/generated/project.blot",
  application_directory,
);
const public_directory = new URL("generated/", application_directory);
const development_runtime_source = fileURLToPath(
  new URL("../../../blot/src/development_runtime.ts", import.meta.url),
);
const publish_project = create_serial_blot_project_publisher(
  publish_project_revision,
);

const configure_application = define_ink_application({
  app_directory: application_directory,
  resource_directories: [],
  source_directories: [
    "src/blot/",
    "../../packages/blot/",
  ],
  build: {
    command: "deno",
    arguments: [
      "run",
      "--config",
      "../../deno.json",
      "--allow-env=INK_VEHICLE_PROJECT_FILE",
      "--allow-read",
      "--allow-write",
      "--allow-run=deno",
      "ink.ts",
    ],
  },
  development_build: create_blot_development_build({
    artifact_name: game_adapter.artifact_name,
    compiler_distribution: {
      wasm: new URL(
        "../../../blot/compiler/target/development-profile/compiler.wasm",
        import.meta.url,
      ),
      prelude_snapshot: new URL(
        "../../../blot/compiler/target/development-profile/prelude.snapshot",
        import.meta.url,
      ),
    },
    project_manifest,
    public_directory,
  }),
});

export default async function configure(
  environment: Parameters<typeof configure_application>[0],
) {
  if (environment.command === "serve") await publish_project();
  const configuration = await configure_application(environment);
  if (environment.command !== "serve") return configuration;

  const {
    bundle_side_effect_free_browser_module,
    serve_browser_module,
  } = await import("@ink/vite/browser-module.ts");
  const runtime_source = await bundle_side_effect_free_browser_module({
    source: `export { DevelopmentRuntime } from ${
      JSON.stringify(development_runtime_source)
    };`,
    resolution_root: new URL("../../packages/blot/", application_directory),
  });
  return {
    ...configuration,
    plugins: [
      vehicle_project_provider(),
      ...(configuration.plugins ?? []),
      serve_browser_module({
        path: "/@ink/blot-development-runtime.js",
        source: runtime_source,
      }),
    ],
  };
}

if (import.meta.main) {
  const project = await compile_project();
  await write_text_atomically(provider_file, project.blot_source);
  await build_blot_game({
    artifact_name: game_adapter.artifact_name,
    compiler: new URL("../../../blot/src/cli.ts", import.meta.url),
    entrypoint: new URL("src/blot/game/main.blot", application_directory),
    public_directory,
    working_directory: application_directory,
  });
  await write_text_atomically(
    new URL("generated/vehicle-project.json", application_directory),
    project.canonical_source,
  );
}

function vehicle_project_provider(): Plugin {
  const project_path = resolve(fileURLToPath(project_file));
  return {
    name: "ink-vehicle-project-provider",
    configureServer(server) {
      server.watcher.add(project_path);
    },
    async buildStart() {
      await publish_project();
    },
    async handleHotUpdate(context) {
      if (resolve(context.file) !== project_path) return;
      await publish_project();
    },
  };
}

async function publish_project_revision(): Promise<void> {
  const project = await compile_project();
  await write_text_atomically(
    new URL("vehicle-project.json", public_directory),
    project.canonical_source,
  );
  await write_text_atomically(provider_file, project.blot_source);
}

async function compile_project() {
  return compile_vehicle_project(await readFile(project_file, "utf8"));
}

function configured_project_file(): URL {
  const configured = typeof Deno === "undefined"
    ? process.env.INK_VEHICLE_PROJECT_FILE
    : Deno.env.get("INK_VEHICLE_PROJECT_FILE");
  const resolved = configured === undefined || configured.trim() === ""
    ? new URL("projects/starter.json", application_directory)
    : new URL(configured, application_directory);
  if (resolved.protocol !== "file:") {
    throw new Error(
      `vehicle project ${JSON.stringify(resolved.href)} must be local`,
    );
  }
  return resolved;
}

async function write_text_atomically(path: URL, source: string): Promise<void> {
  try {
    if (await readFile(path, "utf8") === source) return;
  } catch (error) {
    if (!has_error_code(error, "ENOENT")) throw error;
  }
  await mkdir(dirname(fileURLToPath(path)), { recursive: true });
  const pending = new URL(
    `.${path.pathname.split("/").at(-1)}.${process.pid}.pending`,
    new URL("./", path),
  );
  try {
    await writeFile(pending, source, "utf8");
    await rename(pending, path);
  } catch (error) {
    try {
      await rm(pending, { force: true });
    } catch (cleanup_error) {
      throw new AggregateError(
        [error, cleanup_error],
        `failed to write and clean up ${JSON.stringify(path.href)}`,
      );
    }
    throw error;
  }
}

function has_error_code(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === code;
}
