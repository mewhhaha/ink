import { create_blot_artifact_loader } from "@ink/blot/adapter.ts";
import {
  game_development_path,
  resolve_game_development_view,
} from "@ink/development/browser_routes.ts";
import {
  render_dungeon_debug_view,
  render_dungeon_editor,
} from "../editor/dungeon_editor.tsx";
import { mount_adventure_development } from "./mount_game_development.tsx";

const artifact_name = "adventure_development";
const development_view = resolve_game_development_view(
  location.pathname,
  "editor",
);
if (location.pathname === "/") {
  history.replaceState(null, "", game_development_path(development_view));
}

const root = document.getElementById("root");
if (root === null) throw new Error("adventure development root is missing");

mount_adventure_development(root, {
  assets: {
    wasm_url: `/${artifact_name}.wasm`,
    manifest_url: `/${artifact_name}.wasm.json`,
    asset_manifest_url: "/assets.manifest.json",
  },
  auto_play: development_view !== "editor",
  keyboard_actions: {
    KeyA: { pressed: "left-start", released: "left-stop" },
    KeyD: { pressed: "right-start", released: "right-stop" },
    KeyE: "orbit-right",
    KeyQ: "orbit-left",
    KeyR: "restart",
    KeyS: { pressed: "backward-start", released: "backward-stop" },
    KeyW: { pressed: "forward-start", released: "forward-stop" },
  },
  load_artifact: create_blot_artifact_loader({
    game_id: artifact_name,
    data_assets: [{ id: 0, url: "/assets/levels/starter.json" }],
  }),
  render_editor: development_view === "editor"
    ? render_dungeon_editor
    : development_view === "debug"
    ? render_dungeon_debug_view
    : undefined,
  show_metrics: false,
  show_transport: false,
  workspace_channel: artifact_name,
});
