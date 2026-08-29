import { build_blot_game } from "@ink/blot/build.ts";
import { define_ink_application } from "@ink/vite";

const app_directory = new URL("./", import.meta.url);

export default define_ink_application({
  app_directory,
  source_directories: ["src/"],
  resource_directories: [],
});

if (import.meta.main) {
  await build_blot_game({
    artifact_name: "shrubbery",
    assets_directory: new URL("assets/", app_directory),
    compiler: new URL("../../../blot/src/cli.ts", import.meta.url),
    entrypoint: new URL("src/blot/main.blot", app_directory),
    public_directory: new URL("generated/", app_directory),
    working_directory: app_directory,
  });
}
