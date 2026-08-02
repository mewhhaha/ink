import { GameDevelopment } from "@ink/development/game_development.tsx";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import ground_texture_url from "../assets/ground.webp?inline";
import { isometric_city_assets } from "./game.ts";
import "./styles.css";
import { load_isometric_city_artifact } from "./wasm_game.ts";

const ground_texture = new Image();
ground_texture.src = ground_texture_url;
try {
  await ground_texture.decode();
} catch (cause) {
  throw new Error(
    `ground texture ${JSON.stringify(ground_texture_url)} could not be decoded`,
    { cause },
  );
}
document.documentElement.style.setProperty(
  "--isometric-ground-texture",
  `url(${JSON.stringify(ground_texture_url)})`,
);

const root = document.getElementById("root");
if (!root) {
  throw new Error("isometric city development root element is missing");
}

createRoot(root).render(createElement(GameDevelopment, {
  assets: isometric_city_assets,
  load_artifact: load_isometric_city_artifact,
}));
