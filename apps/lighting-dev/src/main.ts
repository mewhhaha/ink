import { create_simple3d_renderer } from "@ink/rendering/simple3d.ts";
import { lighting_scene } from "./scene.ts";
import "./styles.css";

const canvas = document.getElementById("scene");
const adapter = document.getElementById("adapter");
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("lighting lab index is missing its scene canvas");
}
if (!(adapter instanceof HTMLOutputElement)) {
  throw new Error("lighting lab index is missing its adapter output");
}

try {
  const renderer = await create_simple3d_renderer(canvas);
  adapter.value = renderer.adapter_description;
  const started = performance.now();
  let frame = 0;
  const draw = (now: number) => {
    renderer.render(lighting_scene((now - started) / 1_000));
    frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);
  globalThis.addEventListener("pagehide", () => {
    cancelAnimationFrame(frame);
    renderer.dispose();
  }, { once: true });
} catch (error) {
  adapter.value = error instanceof Error ? error.message : String(error);
  document.body.dataset.renderFailed = "true";
  throw error;
}
