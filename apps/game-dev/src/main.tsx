import { mount_game_development } from "@ink/development/mount_game_development.tsx";
import { load_game_development_artifact } from "./wasm_game.ts";

const root = document.getElementById("root");
if (!root) throw new Error("game development root element is missing");

mount_game_development(root, {
  assets: {
    wasm_url: "/game_development.wasm",
    manifest_url: "/game_development.wasm.json",
  },
  load_artifact: load_game_development_artifact,
});

if (import.meta.hot) import.meta.hot.accept();
