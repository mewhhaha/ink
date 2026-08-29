import { create_simple3d_renderer } from "@ink/rendering/simple3d.ts";
import { run_shrubbery_guest, type ShrubberyResult } from "./guest.ts";
import { shrubbery_scene } from "./scene.ts";
import "./styles.css";

const canvas = required_element("scene", HTMLCanvasElement);
const options = required_element("options", HTMLElement);
const selection_label = required_element("selection", HTMLParagraphElement);
const seed_button = required_element("seed", HTMLButtonElement);
const status = required_element("status", HTMLOutputElement);
const renderer = await create_simple3d_renderer(canvas);
const wasm_response = await fetch("/shrubbery.wasm");
if (!wasm_response.ok) {
  throw new Error(`shrubbery Wasm returned ${wasm_response.status}`);
}
const wasm = await wasm_response.arrayBuffer();
let selected_key = 1;
let seed = 424_242;
let shrubbery: ShrubberyResult | undefined;
let frame = 0;
const started = performance.now();

async function rebuild(): Promise<void> {
  status.value = "Running Blot guest";
  shrubbery = await run_shrubbery_guest(wasm, selected_key, seed);
  selection_label.textContent = shrubbery.selected.name;
  status.value =
    `${shrubbery.voxels.length} voxels · ${renderer.adapter_description}`;
  options.replaceChildren(...shrubbery.options.map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.name;
    button.ariaPressed = String(option.key === selected_key);
    button.addEventListener("click", () => {
      selected_key = option.key;
      void rebuild();
    });
    return button;
  }));
}

seed_button.addEventListener("click", () => {
  seed += 97;
  void rebuild();
});
await rebuild();

const draw = (now: number) => {
  if (shrubbery !== undefined) {
    renderer.render(shrubbery_scene(shrubbery.voxels, (now - started) / 1_000));
  }
  frame = requestAnimationFrame(draw);
};
frame = requestAnimationFrame(draw);
globalThis.addEventListener("pagehide", () => {
  cancelAnimationFrame(frame);
  renderer.dispose();
}, { once: true });

function required_element<T extends Element>(
  id: string,
  constructor: { new (): T },
): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`shrubbery index is missing ${id}`);
  }
  return element;
}
