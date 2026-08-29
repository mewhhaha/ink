import { create_simple3d_renderer } from "@ink/rendering/simple3d.ts";
import { microseconds } from "@ink/runtime/identity.ts";
import {
  create_shrubbery_session,
  shrubbery_observation,
  type ShrubberyObservation,
} from "./runtime.ts";
import { shrubbery_scene } from "./scene.ts";
import "./styles.css";

const canvas = required_element("scene", HTMLCanvasElement);
const options = required_element("options", HTMLElement);
const selection_label = required_element("selection", HTMLParagraphElement);
const seed_button = required_element("seed", HTMLButtonElement);
const status = required_element("status", HTMLOutputElement);
const renderer = await create_simple3d_renderer(canvas);
const [wasm_response, manifest_response] = await Promise.all([
  fetch("/shrubbery.wasm"),
  fetch("/shrubbery.wasm.json"),
]);
if (!wasm_response.ok || !manifest_response.ok) {
  throw new Error(
    `shrubbery artifact returned Wasm ${wasm_response.status} and manifest ${manifest_response.status}`,
  );
}
const session = await create_shrubbery_session(
  new Uint8Array(await wasm_response.arrayBuffer()),
  await manifest_response.text(),
);
let shrubbery: ShrubberyObservation | undefined;
let frame = 0;
const started = performance.now();

async function refresh(): Promise<void> {
  shrubbery = shrubbery_observation(
    await session.observe({
      width: Math.max(1, canvas.clientWidth),
      height: Math.max(1, canvas.clientHeight),
    }),
  );
  selection_label.textContent = shrubbery.selected_name;
  status.value =
    `${shrubbery.voxels.length} voxels · ${renderer.adapter_description}`;
  const selection_actions = shrubbery.actions.filter(({ action }) =>
    action.type === "custom" && action.kind === 10
  );
  options.replaceChildren(...selection_actions.map(({ action, label }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.ariaPressed = String(label === shrubbery?.selected_name);
    button.addEventListener("click", () => {
      void apply_action(action);
    });
    return button;
  }));
}

seed_button.addEventListener("click", () => {
  const action = shrubbery?.actions.find(({ id }) => id === "regenerate")
    ?.action;
  if (action === undefined) {
    throw new Error("Blot shrubbery observation omitted regenerate action");
  }
  void apply_action(action);
});
await refresh();

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
  void session.close();
}, { once: true });

async function apply_action(
  action: Parameters<typeof session.advance>[0]["inputs"][number],
): Promise<void> {
  status.value = "Advancing Blot game";
  await session.advance({ elapsed_us: microseconds(0), inputs: [action] });
  await refresh();
}

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
