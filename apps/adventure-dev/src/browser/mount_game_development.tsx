import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  GameDevelopment,
  type GameDevelopmentProps,
} from "./game_development.tsx";

const development_roots = new WeakMap<Element, Root>();

export function mount_adventure_development(
  container: Element,
  properties: GameDevelopmentProps,
): void {
  let root = development_roots.get(container);
  if (!root) {
    root = createRoot(container);
    development_roots.set(container, root);
  }
  root.render(createElement(GameDevelopment, properties));
}
