import { GameDevelopment } from "@ink/development/game_development.tsx";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { game_development_assets } from "./game.ts";
import { load_game_development_artifact } from "./wasm_game.ts";

const root = document.getElementById("root");
if (!root) throw new Error("game development root element is missing");

createRoot(root).render(createElement(GameDevelopment, {
  assets: game_development_assets,
  load_artifact: load_game_development_artifact,
}));
