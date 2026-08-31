/// <reference types="vite/client" />

import { create_renderer } from "@ink/rendering/renderer.ts";
import { Observer } from "@ink/observability/observer.ts";
import { create_redacting_sink } from "@ink/observability/redaction.ts";
import { create_ring_buffer_sink } from "@ink/observability/sink.ts";
import { microseconds } from "@ink/runtime/identity.ts";
import { subscribe_to_application_updates } from "@ink/vite/client.ts";
import {
  create_shrubbery_development_session,
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
const observation_log = create_ring_buffer_sink(100);
const observer = new Observer({
  source: { subsystem: "shrubbery-development" },
  sink: create_redacting_sink(observation_log),
  clock: { now_seconds: () => performance.now() / 1_000 },
});
const renderer = await create_renderer({
  canvas,
  technique: {
    type: "raster",
    path: "clustered_forward",
    sample_count: 4,
    anti_aliasing: "none",
  },
});
const development_artifacts = {
  async load(path: string): Promise<Uint8Array> {
    const response = await fetch(`/${path}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(
        `Blot development artifact ${
          JSON.stringify(path)
        } returned ${response.status}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  },
};
const development = import.meta.hot === undefined
  ? undefined
  : await create_shrubbery_development_session(
    await fetch_development_revision(),
    development_artifacts,
    await import_development_runtime(),
    observer,
  );
const session = development === undefined
  ? await create_production_session(observer)
  : development.session;
let shrubbery: ShrubberyObservation | undefined;
let release_updates = () => {};

async function refresh(): Promise<void> {
  shrubbery = shrubbery_observation(
    await session.observe({
      width: Math.max(1, canvas.clientWidth),
      height: Math.max(1, canvas.clientHeight),
    }),
  );
  renderer.render(shrubbery_scene(shrubbery.snapshot));
  selection_label.textContent = shrubbery.selected_name;
  status.value =
    `${shrubbery.snapshot.objects.length} voxels · ${observation_log.observations().length} runtime events · ${shrubbery.snapshot.camera.type} Blot camera · ${shrubbery.snapshot.environment.exposure_ev100} EV · ${renderer.adapter_description}`;
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
if (development === undefined || import.meta.hot === undefined) {
  publish_development_evidence({
    type: "production",
    ...active_presentation_evidence(),
  });
} else {
  publish_development_evidence({
    type: "ready",
    revision: development.active_revision(),
    entry_retained: false,
    ...active_presentation_evidence(),
  });
  let updates = Promise.resolve();
  release_updates = subscribe_to_application_updates(
    import.meta.hot,
    (update) => {
      if (update.type === "compilation_error") {
        publish_development_evidence({
          type: "failed",
          revision: development.active_revision(),
          ...active_presentation_evidence(),
        });
        status.value =
          "Blot compilation failed; the last good revision remains active";
        return;
      }
      if (update.type !== "game") return;
      updates = updates.then(async () => {
        publish_development_evidence({
          type: "activating",
          revision: development.active_revision(),
          ...active_presentation_evidence(),
        });
        const activated = await development.activate(
          await fetch_development_revision(),
          development_artifacts,
        );
        await refresh();
        publish_development_evidence({
          type: "ready",
          revision: activated.revision,
          entry_retained: activated.entry_retained,
          ...active_presentation_evidence(),
        });
      }).catch((error) => {
        observer.diagnostic(
          "error",
          "blot.development.activation",
          "Blot development activation failed",
          { cause: error instanceof Error ? error.name : typeof error },
        );
        status.value =
          "Blot activation failed; the last good revision remains active";
        publish_development_evidence({
          type: "failed",
          revision: development.active_revision(),
          ...active_presentation_evidence(),
        });
      });
    },
  );
}

globalThis.addEventListener("pagehide", () => {
  release_updates();
  renderer.dispose();
  void session.close();
}, { once: true });

async function create_production_session(observer: Observer) {
  const [wasm_response, manifest_response] = await Promise.all([
    fetch("/shrubbery.wasm"),
    fetch("/shrubbery.wasm.json"),
  ]);
  if (!wasm_response.ok || !manifest_response.ok) {
    throw new Error(
      `shrubbery artifact returned Wasm ${wasm_response.status} and manifest ${manifest_response.status}`,
    );
  }
  return await create_shrubbery_session(
    new Uint8Array(await wasm_response.arrayBuffer()),
    await manifest_response.text(),
    observer,
  );
}

async function fetch_development_revision(): Promise<unknown> {
  const response = await fetch("/shrubbery.development.json", {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      `shrubbery development revision returned ${response.status}`,
    );
  }
  return await response.json();
}

async function import_development_runtime(): Promise<unknown> {
  const runtime_url = "/@ink/blot-development-runtime.js";
  return await import(/* @vite-ignore */ runtime_url);
}

type DevelopmentEvidence =
  | {
    readonly type: "production";
    readonly camera_type: "orthographic" | "perspective";
    readonly exposure_ev100: number;
    readonly selected_name: string;
  }
  | {
    readonly type: "ready";
    readonly revision: string;
    readonly entry_retained: boolean;
    readonly camera_type: "orthographic" | "perspective";
    readonly exposure_ev100: number;
    readonly selected_name: string;
  }
  | {
    readonly type: "activating" | "failed";
    readonly revision: string;
    readonly camera_type: "orthographic" | "perspective";
    readonly exposure_ev100: number;
    readonly selected_name: string;
  };

function active_presentation_evidence(): Pick<
  DevelopmentEvidence,
  "camera_type" | "exposure_ev100" | "selected_name"
> {
  if (shrubbery === undefined) {
    throw new Error("shrubbery development evidence needs an observation");
  }
  return {
    camera_type: shrubbery.snapshot.camera.type,
    exposure_ev100: shrubbery.snapshot.environment.exposure_ev100,
    selected_name: shrubbery.selected_name,
  };
}

function publish_development_evidence(evidence: DevelopmentEvidence): void {
  document.body.dataset.developmentEvidence = JSON.stringify(evidence);
}

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
