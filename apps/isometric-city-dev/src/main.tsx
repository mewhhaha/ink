import { mount_game_development } from "@ink/development/mount_game_development.tsx";
import { createElement } from "react";
import { CityEditor } from "./city_editor.tsx";
import { city_pointer_action } from "./city_editor_logic.ts";
import { isometric_city_assets } from "./game.ts";
import { load_isometric_city_artifact } from "./wasm_game.ts";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("isometric city development root element is missing");
}

mount_game_development(root, {
  assets: isometric_city_assets,
  load_artifact: load_isometric_city_artifact,
  pointer_action: city_pointer_action,
  render_editor: (context) => createElement(CityEditor, context),
  show_debugger: true,
});

if (import.meta.hot) import.meta.hot.accept();
