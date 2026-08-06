import { build_ink_game } from "@ink/development/game_build.ts";

const app_directory = new URL("./", import.meta.url);

await build_ink_game({
  artifact_name: "game_development",
  assets_directory: new URL("assets/", app_directory),
  compiler: new URL("../../../blot/src/cli.ts", import.meta.url),
  entrypoint: new URL("blot/game/main.blot", app_directory),
  public_directory: new URL("generated/", app_directory),
  working_directory: app_directory,
});
