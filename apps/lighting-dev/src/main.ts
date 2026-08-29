import { parse_static_glb_scene } from "@ink/assets/gltf_model.ts";
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
  const model_response = await fetch(
    "/assets/bevy/VolumetricFogExample.glb",
  );
  if (!model_response.ok) {
    throw new Error(
      `Bevy reference scene failed with HTTP ${model_response.status}`,
    );
  }
  const reference_scene = parse_static_glb_scene(
    new Uint8Array(await model_response.arrayBuffer()),
    "assets/bevy/VolumetricFogExample.glb",
  );
  const renderer = await create_simple3d_renderer(canvas);
  adapter.value = renderer.adapter_description;
  const started = performance.now();
  let frame = 0;
  const draw = (now: number) => {
    renderer.render(lighting_scene((now - started) / 1_000, reference_scene));
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
