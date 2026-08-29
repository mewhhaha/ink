import {
  build_blot_game,
  create_blot_development_build,
} from "@ink/blot/build.ts";
import { define_ink_application } from "@ink/vite";

const app_directory = new URL("./", import.meta.url);
const compiler = new URL("../../../blot/src/cli.ts", import.meta.url);
const entrypoint = new URL("src/blot/main.blot", app_directory);
const public_directory = new URL("generated/", app_directory);

export default define_ink_application({
  app_directory,
  source_directories: ["src/"],
  resource_directories: [],
  development_build: create_blot_development_build({
    artifact_name: "shrubbery",
    compiler_module: new URL(
      "../../../blot/dist/src/compiler.js",
      import.meta.url,
    ),
    entrypoint,
    project_manifest: new URL("blot.json", app_directory),
    public_directory,
  }),
});

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
