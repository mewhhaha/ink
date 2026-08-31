/// <reference types="vite/client" />

import {
  type BlotHostEffect,
  game_action_from_ui_event,
  type GameAction,
} from "@ink/blot/protocol.ts";
import type { BlotPresentation } from "@ink/blot/runtime.ts";
import { vec2 } from "@ink/math/vector.ts";
import { create_renderer } from "@ink/rendering/renderer.ts";
import { microseconds, type RuntimeRevision } from "@ink/runtime/session.ts";
import { BrowserUiAdapter } from "@ink/ui/browser.ts";
import { layout_ui } from "@ink/ui/layout.ts";
import type { LocalizationResolver } from "@ink/ui/localization.ts";
import { subscribe_to_application_updates } from "@ink/vite/client.ts";
import { create_browser_strategy_audio } from "./audio.ts";
import {
  serialize_strategy_browser_evidence,
  serialize_strategy_development_evidence,
  strategy_browser_evidence,
  type StrategyDevelopmentEvidence,
} from "./browser_evidence.ts";
import { strategy_render_scene } from "./rendering.ts";
import {
  create_strategy_development_runtime,
  create_strategy_runtime,
} from "./runtime.ts";

const application = required_element("application", HTMLElement);
const canvas = required_element("scene", HTMLCanvasElement);
const semantic_layer = required_element("semantic-layer", HTMLDivElement);
const status = required_element("status", HTMLHeadingElement);
const presentation_output = required_element(
  "presentation",
  HTMLOutputElement,
);
const artifact_name = "strategy_development";
const viewport = Object.freeze({ width: 960, height: 540 });
const literal_resolver: LocalizationResolver = {
  resolve(id) {
    throw new Error(
      `strategy UI unexpectedly requested localization message ${
        JSON.stringify(id)
      }`,
    );
  },
};

try {
  await run_strategy();
} catch (error) {
  application.dataset.runtimeState = "failed";
  status.textContent = "Frontier Assault failed to start";
  throw error;
}

async function run_strategy(): Promise<void> {
  const development_artifacts = {
    async load(path: string): Promise<Uint8Array> {
      const response = await fetch(`/${path}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(
          `strategy development artifact ${
            JSON.stringify(path)
          } returned ${response.status}`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
  const development_runtime = import.meta.hot === undefined
    ? undefined
    : await create_strategy_development_runtime(
      await fetch_development_revision(),
      development_artifacts,
      await import_development_runtime(),
    );
  const runtime = development_runtime ?? await create_production_runtime();
  const development = development_runtime?.development;
  const renderer = await create_renderer({
    canvas,
    technique: {
      type: "raster",
      path: "clustered_forward",
      sample_count: 4,
      anti_aliasing: "none",
    },
  });
  const audio_host = create_browser_strategy_audio();
  const audio_effects: BlotHostEffect[] = [];
  let latest_presentation: BlotPresentation | undefined;
  let latest_revision: RuntimeRevision | undefined;
  let audio_sequence: number | undefined;
  let transition = Promise.resolve();
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

  await refresh();
  application.dataset.runtimeState = "ready";
  if (development === undefined || import.meta.hot === undefined) {
    publish_development_evidence({ type: "production" });
  } else {
    publish_development_evidence({
      type: "ready",
      revision: development.active_revision(),
      entry_retained: false,
      status_value: active_status_value(),
    });
    let activations = Promise.resolve();
    release_updates = subscribe_to_application_updates(
      import.meta.hot,
      (update) => {
        if (update.type === "compilation_error") {
          publish_development_evidence({
            type: "failed",
            revision: development.active_revision(),
            status_value: active_status_value(),
          });
          return;
        }
        if (update.type !== "game") return;
        activations = activations.then(async () => {
          publish_development_evidence({
            type: "activating",
            revision: development.active_revision(),
            status_value: active_status_value(),
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
            status_value: active_status_value(),
          });
        }).catch((error) => {
          runtime.observations.observer.diagnostic(
            "error",
            "strategy.development.activation",
            "Strategy Blot activation failed",
            { cause: error instanceof Error ? error.name : typeof error },
          );
          publish_development_evidence({
            type: "failed",
            revision: development.active_revision(),
            status_value: active_status_value(),
          });
        });
      },
    );
  }

  globalThis.addEventListener("pagehide", () => {
    release_updates();
    ui.dispose();
    renderer.dispose();
    void audio_host.close();
    void runtime.session.close();
  }, { once: true });

  async function apply_action(action: GameAction): Promise<void> {
    await audio_host.activate();
    latest_revision = await runtime.session.advance({
      elapsed_us: microseconds(0),
      inputs: [action],
    });
    await refresh();
  }

  async function refresh(): Promise<void> {
    const presentation = await runtime.session.observe(viewport);
    latest_presentation = presentation;
    if (audio_sequence !== presentation.observation.sequence) {
      audio_sequence = presentation.observation.sequence;
      audio_effects.push(...presentation.effects);
      for (const effect of presentation.effects) {
        audio_host.play(effect.cue);
        runtime.observations.observer.event("strategy.browser.audio", {
          effect_id: effect.id,
          cue: String(effect.cue),
        });
      }
    }
    const scene = strategy_render_scene(
      presentation.snapshot,
      presentation.observation.sequence,
    );
    const frame = renderer.render(scene);
    const pick = renderer.pick(scene, {
      x: Math.max(1, canvas.clientWidth) / 2,
      y: Math.max(1, canvas.clientHeight) / 2,
    });
    runtime.observations.observer.event("strategy.browser.presentation", {
      game_text: presentation.observation.status.value,
      projection: presentation.snapshot.camera.type,
      ui_revision: presentation.observation.ui.revision,
    });
    runtime.observations.observer.event("strategy.browser.render", {
      frame_type: frame.type,
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
    });
    if (layout.type === "rejected") {
      throw new Error(
        `strategy UI node ${
          JSON.stringify(layout.node)
        } could not be laid out: ${layout.reason}`,
      );
    }
    ui.update(presentation.observation.ui, layout.entries, literal_resolver);
    status.textContent =
      `${presentation.observation.status.label}: ${presentation.observation.status.value}`;
    const audio_host_evidence = audio_host.evidence();
    const evidence = strategy_browser_evidence(
      presentation,
      latest_revision,
      renderer,
      frame,
      pick,
      runtime.observations,
      audio_effects,
      audio_host_evidence,
    );
    presentation_output.value =
      `${presentation.snapshot.camera.type} Blot camera · ${presentation.snapshot.environment.exposure_ev100} EV\n` +
      `${renderer.adapter_description}\n${audio_host_evidence.submitted_cues} applied audio cues\n` +
      `${evidence.observations.retained}/${evidence.observations.capacity} observations retained\n` +
      evidence.observations.redacted_debugger_message;
    application.dataset.strategyEvidence = serialize_strategy_browser_evidence(
      evidence,
    );
  }

  function active_status_value(): string {
    if (latest_presentation === undefined) {
      throw new Error("strategy development evidence needs a presentation");
    }
    return latest_presentation.observation.status.value;
  }
}

async function create_production_runtime() {
  const [wasm_response, manifest_response] = await Promise.all([
    fetch(`/${artifact_name}.wasm`, { cache: "no-store" }),
    fetch(`/${artifact_name}.wasm.json`, { cache: "no-store" }),
  ]);
  if (!wasm_response.ok || !manifest_response.ok) {
    throw new Error(
      `strategy artifact returned Wasm ${wasm_response.status} and manifest ${manifest_response.status}`,
    );
  }
  return await create_strategy_runtime({
    wasm_bytes: new Uint8Array(await wasm_response.arrayBuffer()),
    manifest_source: await manifest_response.text(),
  });
}

async function fetch_development_revision(): Promise<unknown> {
  const response = await fetch(`/${artifact_name}.development.json`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      `strategy development revision returned ${response.status}`,
    );
  }
  return await response.json();
}

async function import_development_runtime(): Promise<unknown> {
  const runtime_url = "/@ink/blot-development-runtime.js";
  return await import(/* @vite-ignore */ runtime_url);
}

function publish_development_evidence(
  evidence: StrategyDevelopmentEvidence,
): void {
  application.dataset.developmentEvidence =
    serialize_strategy_development_evidence(evidence);
}

function required_element<T extends Element>(
  id: string,
  constructor: { new (): T },
): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`strategy index is missing ${id}`);
  }
  return element;
}
