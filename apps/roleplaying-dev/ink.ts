import { build_blot_game } from "@ink/blot/build.ts";
import { define_ink_application } from "@ink/vite";
import { game_adapter } from "./src/game_adapter.ts";
import { compile_roleplaying_project } from "./src/project.ts";

const app_directory = new URL("./", import.meta.url);

export default define_ink_application({
  app_directory,
  source_directories: ["projects/", "src/blot/", "../../packages/blot/"],
});

if (import.meta.main) {
  const project = compile_roleplaying_project(
    await Deno.readTextFile(new URL("projects/starter.json", app_directory)),
  );
  await Deno.mkdir(new URL("src/blot/generated/", app_directory), {
    recursive: true,
  });
  await Deno.writeTextFile(
    new URL("src/blot/generated/project.blot", app_directory),
    project.blot_source,
  );
  await build_blot_game({
    artifact_name: game_adapter.artifact_name,
    assets_directory: new URL("assets/", app_directory),
    compiler: new URL("../../../blot/src/cli.ts", import.meta.url),
    entrypoint: new URL("src/blot/game/main.blot", app_directory),
    public_directory: new URL("generated/", app_directory),
    working_directory: app_directory,
  });
}
