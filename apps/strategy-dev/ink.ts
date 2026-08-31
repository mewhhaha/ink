import {
  build_blot_game,
  create_blot_development_build,
  create_serial_blot_project_publisher,
} from "@ink/blot/build.ts";
import { define_ink_application } from "@ink/vite";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin } from "vite";
import { game_adapter } from "./src/game_adapter.ts";
import { compile_strategy_project } from "./src/project.ts";

const application_directory = new URL("./", import.meta.url);
const development_root = configured_development_root();
const project_file = configured_project_file(development_root);
const project_manifest = new URL("blot.json", development_root);
const provider_file = new URL(
  "src/blot/generated/project.blot",
  development_root,
);
const public_directory = new URL("generated/", application_directory);
const blot_development_runtime = fileURLToPath(
  new URL("../../../blot/src/development_runtime.ts", import.meta.url),
);
const publish_project_provider = create_serial_blot_project_publisher(
  publish_project_provider_revision,
);

const configure_application = define_ink_application({
  app_directory: application_directory,
  resource_directories: [],
  source_directories: [
    new URL("src/blot/", development_root),
    "../../packages/blot/",
  ],
  build: {
    command: "deno",
    arguments: [
      "run",
      "--config",
      "../../deno.json",
      "--allow-env=INK_STRATEGY_PROJECT_FILE,INK_STRATEGY_DEVELOPMENT_ROOT",
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
  if (environment.command === "serve") await publish_project_provider();
  const configuration = await configure_application(environment);
  if (environment.command !== "serve") return configuration;

  const {
    bundle_side_effect_free_browser_module,
    serve_browser_module,
  } = await import("@ink/vite/browser-module.ts");
  const runtime_source = await bundle_side_effect_free_browser_module({
    source: `export { DevelopmentRuntime } from ${
      JSON.stringify(blot_development_runtime)
    };`,
    resolution_root: new URL("../../packages/blot/", application_directory),
  });
  return {
    ...configuration,
    plugins: [
      strategy_project_provider(),
      ...(configuration.plugins ?? []),
      serve_browser_module({
        path: "/@ink/blot-development-runtime.js",
        source: runtime_source,
      }),
    ],
  };
}

if (import.meta.main) {
  const compiled = await compile_project();
  await write_text_atomically(
    new URL("src/blot/generated/project.blot", application_directory),
    compiled.blot_source,
  );
  await build_blot_game({
    artifact_name: game_adapter.artifact_name,
    compiler: new URL("../../../blot/src/cli.ts", import.meta.url),
    entrypoint: new URL("src/blot/game/main.blot", application_directory),
    public_directory,
    working_directory: application_directory,
  });
  await write_text_atomically(
    new URL("generated/strategy-project.json", application_directory),
    compiled.canonical_source,
  );
}

function strategy_project_provider(): Plugin {
  const project_path = resolve(fileURLToPath(project_file));
  return {
    name: "ink-strategy-project-provider",
    configureServer(server) {
      server.watcher.add(project_path);
    },
    async buildStart() {
      await publish_project_provider();
    },
    async handleHotUpdate(context) {
      if (resolve(context.file) !== project_path) return;
      await publish_project_provider();
    },
  };
}

async function publish_project_provider_revision(): Promise<void> {
  const compiled = await compile_project();
  await write_text_atomically(provider_file, compiled.blot_source);
}

async function compile_project() {
  return compile_strategy_project(await readFile(project_file, "utf8"));
}

function configured_development_root(): URL {
  const configured = environment("INK_STRATEGY_DEVELOPMENT_ROOT");
  if (configured === undefined || configured.trim() === "") {
    return application_directory;
  }
  const root = pathToFileURL(resolve(configured));
  root.pathname += root.pathname.endsWith("/") ? "" : "/";
  return root;
}

function configured_project_file(root: URL): URL {
  const configured = environment("INK_STRATEGY_PROJECT_FILE");
  const resolved = configured === undefined || configured.trim() === ""
    ? new URL("projects/starter.json", root)
    : pathToFileURL(resolve(configured));
  if (resolved.protocol !== "file:") {
    throw new Error(
      `strategy project ${JSON.stringify(resolved.href)} must be local`,
    );
  }
  return resolved;
}

function environment(name: string): string | undefined {
  return typeof Deno === "undefined" ? process.env[name] : Deno.env.get(name);
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
