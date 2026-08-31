/// <reference types="vite/client" />

import {
  type ActionDescription,
  game_action_from_ui_event,
  type GameAction,
} from "@ink/blot/protocol.ts";
import type { BlotPresentation } from "@ink/blot/runtime.ts";
import { BrowserInputAdapter } from "@ink/input/browser.ts";
import { vec2 } from "@ink/math/vector.ts";
import { create_renderer } from "@ink/rendering/renderer.ts";
import { microseconds } from "@ink/runtime/identity.ts";
import type { RuntimeRevision } from "@ink/runtime/session.ts";
import { BrowserUiAdapter } from "@ink/ui/browser.ts";
import { layout_ui } from "@ink/ui/layout.ts";
import type { LocalizationResolver } from "@ink/ui/localization.ts";
import { subscribe_to_application_updates } from "@ink/vite/client.ts";
import {
  create_browser_platformer_asset_source,
  load_platformer_level_asset,
} from "./assets.ts";
import {
  platformer_browser_evidence,
  serialize_platformer_browser_evidence,
} from "./browser_evidence.ts";
import { PlatformerInputController } from "./input.ts";
import { platformer_render_scene } from "./rendering.ts";
import {
  create_platformer_development_runtime,
  create_platformer_runtime,
} from "./runtime.ts";

const application = required_element("application", HTMLElement);
const canvas = required_element("scene", HTMLCanvasElement);
const semantic_layer = required_element("semantic-layer", HTMLDivElement);
const startup_status = required_element("startup-status", HTMLParagraphElement);
const diagnostics = required_element("diagnostics", HTMLOutputElement);
const artifact_name = "platformer_development";
const platformer_keyboard_codes = new Set(["ArrowRight", "Space"]);
const viewport = Object.freeze({ width: 960, height: 540 });
const literal_resolver: LocalizationResolver = {
  resolve(id) {
    throw new Error(
      `platformer UI unexpectedly requested localization message ${
        JSON.stringify(id)
      }`,
    );
  },
};
try {
  await run_platformer();
} catch (error) {
  application.dataset.runtimeState = "failed";
  startup_status.textContent = "Platformer failed to start";
  throw error;
}

async function run_platformer(): Promise<void> {
  const level_assets = create_browser_platformer_asset_source(
    "/assets.manifest.json",
  );
  const level_source = await load_platformer_level_asset(level_assets);
  const development_artifacts = browser_development_artifacts();
  const development_runtime = import.meta.hot === undefined
    ? undefined
    : await create_platformer_development_runtime(
      await fetch_development_revision(),
      development_artifacts,
      await import_development_runtime(),
      level_source,
    );
  const runtime = development_runtime ??
    await create_production_runtime(level_source);
  const renderer = await create_renderer({
    canvas,
    technique: {
      type: "raster",
      path: "clustered_forward",
      sample_count: 4,
      anti_aliasing: "none",
    },
  });
  const browser_input = new BrowserInputAdapter({
    keyboard_target: globalThis,
    pointer_target: canvas,
    focus_target: globalThis,
    pointer_lock_target: document,
    accept_keyboard(event) {
      if (!platformer_keyboard_codes.has(event.code)) return false;
      event.preventDefault();
      return true;
    },
    observer: runtime.observations.observer,
    pointer_locked: () => document.pointerLockElement === canvas,
  });
  const input = new PlatformerInputController(browser_input);
  let frame = 0;
  let previous_frame = performance.now();
  let latest_presentation: BlotPresentation | undefined;
  let latest_revision: RuntimeRevision | undefined;
  let action_descriptions: readonly ActionDescription[] = Object.freeze([]);
  let transition = Promise.resolve();
  let runtime_operations = Promise.resolve();
  let release_updates = () => {};
  const ui = new BrowserUiAdapter({
    document,
    root: semantic_layer,
    observer: runtime.observations.observer,
    dispatch(event) {
      if (event.type !== "activated") return;
      const current = latest_presentation;
      if (current === undefined) return;
      const action = game_action_from_ui_event(current.observation, event);
      if (action === undefined) return;
      transition = transition.then(() => apply_action(action));
    },
  });

  const capture_keyboard = (event: Event) => {
    if (!(event instanceof KeyboardEvent)) return;
    if (!platformer_keyboard_codes.has(event.code)) return;
    if (event.type === "keydown" && event.repeat) return;
    void apply_input();
  };
  globalThis.addEventListener("keydown", capture_keyboard);
  globalThis.addEventListener("keyup", capture_keyboard);

  await refresh();
  application.dataset.runtimeState = "ready";
  startup_status.hidden = true;
  if (development_runtime === undefined || import.meta.hot === undefined) {
    publish_development_evidence({ type: "production" });
  } else {
    const development = development_runtime.development;
    publish_development_evidence({
      type: "ready",
      revision: development.active_revision(),
      entry_retained: false,
      state_preserved: false,
    });
    let activations = Promise.resolve();
    release_updates = subscribe_to_application_updates(
      import.meta.hot,
      (update) => {
        if (update.type === "compilation_error") {
          publish_development_evidence({
            type: "failed",
            revision: development.active_revision(),
          });
          return;
        }
        if (update.type !== "game") return;
        activations = activations.then(async () => {
          publish_development_evidence({
            type: "activating",
            revision: development.active_revision(),
          });
          const activated = await run_runtime_operation(async () => {
            const result = await development_runtime.activate(
              await fetch_development_revision(),
              development_artifacts,
              await load_platformer_level_asset(level_assets),
            );
            await refresh();
            return result;
          });
          publish_development_evidence({ type: "ready", ...activated });
        }).catch((error) => {
          runtime.observations.observer.diagnostic(
            "error",
            "platformer.development.activation",
            "Platformer Blot activation failed",
            { cause: error instanceof Error ? error.name : typeof error },
          );
          publish_development_evidence({
            type: "failed",
            revision: development.active_revision(),
          });
        });
      },
    );
  }
  frame = requestAnimationFrame(advance_frame);
  globalThis.addEventListener("pagehide", () => {
    release_updates();
    cancelAnimationFrame(frame);
    globalThis.removeEventListener("keydown", capture_keyboard);
    globalThis.removeEventListener("keyup", capture_keyboard);
    browser_input.dispose();
    ui.dispose();
    renderer.dispose();
    void runtime.session.close();
  }, { once: true });

  async function advance_frame(now: number): Promise<void> {
    const elapsed_us = Math.min(
      50_000,
      Math.round((now - previous_frame) * 1_000),
    );
    previous_frame = now;
    await run_runtime_operation(async () => {
      latest_revision = await runtime.session.advance({
        elapsed_us: microseconds(elapsed_us),
        inputs: [],
      });
      await refresh();
    });
    frame = requestAnimationFrame(advance_frame);
  }

  async function refresh(): Promise<void> {
    const presentation = await runtime.session.observe(viewport);
    latest_presentation = presentation;
    const scene = platformer_render_scene(
      presentation.snapshot,
      presentation.observation.sequence,
    );
    const rendered_frame = renderer.render(scene);
    const center_pick = renderer.pick(scene, {
      x: Math.max(1, canvas.clientWidth) / 2,
      y: Math.max(1, canvas.clientHeight) / 2,
    });
    runtime.observations.observer.event("platformer.browser.presentation", {
      game_text: presentation.observation.status.value,
      projection: presentation.snapshot.camera.type,
      ui_revision: presentation.observation.ui.revision,
    });
    runtime.observations.observer.event("platformer.browser.render", {
      frame_type: rendered_frame.type,
      renderer_status: renderer.status.type,
      validation_errors: renderer.validation_error_count,
    });
    const bounds = semantic_layer.getBoundingClientRect();
    const layout = layout_ui(presentation.observation.ui, {
      viewport: vec2(Math.max(1, bounds.width), Math.max(1, bounds.height)),
      player_scale: 1,
      reduced_motion: globalThis.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches ?? false,
      observer: runtime.observations.observer,
    });
    if (layout.type === "rejected") {
      throw new Error(
        `platformer UI node ${
          JSON.stringify(layout.node)
        } could not be laid out: ${layout.reason}`,
      );
    }
    ui.update(presentation.observation.ui, layout.entries, literal_resolver);
    const retained_observations = runtime.observations.log.observations()
      .length;
    const redacted_presentation_message = [
      ...runtime.observations.debugger_entries(),
    ].reverse().find(({ message }) =>
      message.includes("platformer.browser.presentation")
    )?.message;
    if (redacted_presentation_message === undefined) {
      throw new Error(
        "platformer debugger omitted its presentation observation",
      );
    }
    const evidence = platformer_browser_evidence(
      presentation,
      latest_revision,
      retained_observations,
      input.encoded_frames(),
      scene,
      renderer,
      rendered_frame,
      center_pick,
    );
    action_descriptions = presentation.observation.actions;
    diagnostics.value = `player (${
      (evidence.scene.player_position[0] / 1_000_000).toFixed(2)
    }, ${
      (evidence.scene.player_position[1] / 1_000_000).toFixed(2)
    })\n${presentation.snapshot.camera.type} Blot camera · ${presentation.snapshot.environment.exposure_ev100} EV\n${renderer.adapter_description}\nobservations ${retained_observations}/${runtime.observations.log.capacity}\n${redacted_presentation_message}`;
    application.dataset.platformerEvidence =
      serialize_platformer_browser_evidence(evidence);
  }

  async function apply_action(action: GameAction): Promise<void> {
    await run_runtime_operation(async () => {
      latest_revision = await runtime.session.advance({
        elapsed_us: microseconds(0),
        inputs: [action],
      });
      await refresh();
    });
  }

  async function apply_input(): Promise<void> {
    await run_runtime_operation(async () => {
      const captured_actions = input.capture_actions(action_descriptions);
      if (captured_actions.length > 0) {
        latest_revision = await runtime.session.advance({
          elapsed_us: microseconds(0),
          inputs: captured_actions,
        });
      }
      await refresh();
    });
  }

  function run_runtime_operation<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const pending = runtime_operations.then(operation, operation);
    runtime_operations = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

async function create_production_runtime(level_source: string) {
  const [wasm_response, manifest_response] = await Promise.all([
    fetch(`/${artifact_name}.wasm`, { cache: "no-store" }),
    fetch(`/${artifact_name}.wasm.json`, { cache: "no-store" }),
  ]);
  if (!wasm_response.ok || !manifest_response.ok) {
    throw new Error(
      `platformer artifact returned Wasm ${wasm_response.status} and manifest ${manifest_response.status}`,
    );
  }
  return await create_platformer_runtime({
    wasm_bytes: new Uint8Array(await wasm_response.arrayBuffer()),
    manifest_source: await manifest_response.text(),
    level_source,
  });
}

function browser_development_artifacts() {
  return {
    async load(path: string): Promise<Uint8Array> {
      const response = await fetch(`/${path}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(
          `platformer development artifact ${
            JSON.stringify(path)
          } returned ${response.status}`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

async function fetch_development_revision(): Promise<unknown> {
  const response = await fetch(`/${artifact_name}.development.json`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      `platformer development revision returned ${response.status}`,
    );
  }
  return await response.json();
}

async function import_development_runtime(): Promise<unknown> {
  const runtime_url = "/@ink/blot-development-runtime.js";
  return await import(/* @vite-ignore */ runtime_url);
}

type DevelopmentEvidence =
  | { readonly type: "production" }
  | {
    readonly type: "activating" | "failed";
    readonly revision: string;
  }
  | {
    readonly type: "ready";
    readonly revision: string;
    readonly entry_retained: boolean;
    readonly state_preserved: boolean;
  };

function publish_development_evidence(evidence: DevelopmentEvidence): void {
  application.dataset.developmentStatus = evidence.type;
  if (evidence.type === "production") return;
  application.dataset.developmentRevision = evidence.revision;
  if (evidence.type !== "ready") return;
  application.dataset.developmentEntryRetained = String(
    evidence.entry_retained,
  );
  application.dataset.developmentStatePreserved = String(
    evidence.state_preserved,
  );
}

function required_element<T extends Element>(
  id: string,
  constructor: { new (): T },
): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`platformer index is missing ${id}`);
  }
  return element;
}
