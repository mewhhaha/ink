import {
  build_blot_game,
  create_blot_development_build,
} from "@ink/blot/build.ts";
import { define_ink_application } from "@ink/vite";
import { fileURLToPath, pathToFileURL } from "node:url";

const app_directory = new URL("./", import.meta.url);
const compiler = new URL("../../../blot/src/cli.ts", import.meta.url);
const entrypoint = new URL("src/blot/main.blot", app_directory);
const public_directory = new URL("generated/", app_directory);
const blot_development_runtime = fileURLToPath(
  new URL("../../../blot/src/development_runtime.ts", import.meta.url),
);
const configured_project = import.meta.main
  ? undefined
  : process.env.INK_SHRUBBERY_PROJECT;
const project_manifest = configured_project === undefined
  ? new URL("blot.json", app_directory)
  : pathToFileURL(configured_project);

const configure_application = define_ink_application({
  app_directory,
  source_directories: configured_project === undefined
    ? ["src/"]
    : [new URL("./", project_manifest), "src/"],
  resource_directories: [],
  development_build: create_blot_development_build({
    artifact_name: "shrubbery",
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
    resolution_root: new URL("../../packages/blot/", app_directory),
  });
  return {
    ...configuration,
    plugins: [
      ...(configuration.plugins ?? []),
      serve_browser_module({
        path: "/@ink/blot-development-runtime.js",
        source: runtime_source,
      }),
    ],
  };
}

if (import.meta.main) {
  await build_blot_game({
    artifact_name: "shrubbery",
    assets_directory: new URL("assets/", app_directory),
    compiler,
    entrypoint,
    public_directory,
    working_directory: app_directory,
  });
}
