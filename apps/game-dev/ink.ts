import { build_ink_game } from "@ink/development/game_build.ts";
import { blot } from "@ink/blot/adapter.ts";
import { define_ink_game } from "@ink/vite";
import { level_asset_url } from "./src/editor/level.ts";
import { platformer_level_document } from "./src/editor/vite.ts";

const app_directory = new URL("./", import.meta.url);
export const game_adapter = blot({
  game_id: "game_development",
  data_assets: [{ id: 0, url: level_asset_url }],
});

const configure_game = define_ink_game({
  adapter: game_adapter,
  app_directory,
  development: {
    auto_play: true,
    gizmo_object_ranges: [{
      category: "collisions",
      first_object_id: 1000,
      object_count: 24 * 14,
      box_mesh: 0,
    }],
    keyboard_actions: {
      a: { pressed: "move-left-start", released: "move-left-stop" },
      ArrowLeft: { pressed: "move-left-start", released: "move-left-stop" },
      d: { pressed: "move-right-start", released: "move-right-stop" },
      ArrowRight: {
        pressed: "move-right-start",
        released: "move-right-stop",
      },
      ArrowUp: "jump",
      r: "restart",
      " ": "jump",
      w: "jump",
    },
    show_metrics: false,
    show_transport: false,
  },
  editor: {
    browser_module: "src/editor/platformer_editor.tsx",
    browser_export: "render_platformer_editor",
  },
  source_directories: ["src/blot/", "../../packages/blot/"],
});

export default async function configure(
  environment: Parameters<typeof configure_game>[0],
) {
  const configuration = await configure_game(environment);
  return {
    ...configuration,
    plugins: [
      platformer_level_document(
        new URL("assets/levels/starter.json", app_directory),
      ),
      ...(configuration.plugins ?? []),
    ],
  };
}

if (import.meta.main) {
  await build_ink_game({
    artifact_name: game_adapter.artifact_name,
    assets_directory: new URL("assets/", app_directory),
    compiler: new URL("../../../blot/src/cli.ts", import.meta.url),
    entrypoint: new URL("src/blot/game/main.blot", app_directory),
    public_directory: new URL("generated/", app_directory),
    working_directory: app_directory,
  });
}
