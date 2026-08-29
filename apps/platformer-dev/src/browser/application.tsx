/// <reference types="vite/client" />

import type { GameAction, GameViewport } from "@ink/blot/protocol.ts";
import {
  blot_runtime_codec,
  type BlotPresentation,
  type BlotRuntimeGuest,
} from "@ink/blot/runtime.ts";
import { DevelopmentController } from "@ink/development/controller.ts";
import { BrowserInputAdapter } from "@ink/input/browser.ts";
import { Observer } from "@ink/observability/observer.ts";
import { no_observations } from "@ink/observability/sink.ts";
import { move_platformer_record } from "@ink/platformer-editor/commands.ts";
import { platformer_record_id } from "@ink/platformer-editor/identity.ts";
import type { PlatformerProject } from "@ink/platformer-editor/model.ts";
import {
  parse_platformer_project,
  serialize_platformer_project,
} from "@ink/platformer-editor/serialization.ts";
import { PlatformerWorkspace } from "@ink/platformer-editor/workspace.tsx";
import {
  create_preview_renderer,
  type PreviewRenderer,
} from "@ink/rendering/compatibility_renderer.ts";
import { frame_id } from "@ink/runtime/frame.ts";
import { microseconds } from "@ink/runtime/session.ts";
import {
  type ApplicationUpdate,
  subscribe_to_application_updates,
} from "@ink/vite/client.ts";
import { useEffect, useRef, useState } from "react";
import { platformer_project_save_url } from "../editor/project_route.ts";
import { create_platformer_guest } from "../runtime.ts";
import { PlatformerInputMap } from "./input.ts";
import { platformer_shader_source } from "./platformer_shader.ts";
import {
  create_browser_platformer_assets,
  type PlatformerSceneAssetStore,
} from "./scene_asset.ts";
import "./styles.css";

const artifact_name = "platformer_development";
const viewport: GameViewport = { width: 960, height: 540 };
const input_map = new PlatformerInputMap({
  ArrowLeft: { pressed: "left-start", released: "left-stop" },
  ArrowRight: { pressed: "right-start", released: "right-stop" },
  KeyA: { pressed: "left-start", released: "left-stop" },
  KeyD: { pressed: "right-start", released: "right-stop" },
  KeyR: "restart",
  Space: "jump",
});

interface PlatformerArtifactSource {
  readonly wasm_bytes: Uint8Array;
  readonly manifest_source: string;
}

type PlatformerController = DevelopmentController<
  GameAction,
  GameViewport,
  BlotPresentation,
  PlatformerArtifactSource
>;

export function PlatformerDevelopment() {
  const main_reference = useRef<HTMLElement>(null);
  const canvas_reference = useRef<HTMLCanvasElement>(null);
  const controller_reference = useRef<PlatformerController | null>(null);
  const renderer_reference = useRef<PreviewRenderer | null>(null);
  const presentation_reference = useRef<BlotPresentation | undefined>(
    undefined,
  );
  const playing_reference = useRef(false);
  const [presentation, set_presentation] = useState<BlotPresentation>();
  const [project, set_project] = useState<PlatformerProject>();
  const [selected_record, set_selected_record] = useState<string>();
  const [runtime_state, set_runtime_state] = useState("loading");
  const [runtime_message, set_runtime_message] = useState("Loading platformer");
  const [runtime_notice, set_runtime_notice] = useState<string>();
  const [renderer_mode, set_renderer_mode] = useState("loading");
  const [gpu_adapter, set_gpu_adapter] = useState("unavailable");
  const [playback, set_playback] = useState<"paused" | "playing">("paused");

  useEffect(() => {
    let active = true;
    void load_project().then((loaded) => {
      if (active) set_project(loaded);
    }).catch((error) => {
      if (active) set_runtime_notice(error_message(error));
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const main = main_reference.current;
    const canvas = canvas_reference.current;
    if (main === null || canvas === null) return;
    canvas.setAttribute("layoutsubtree", "");
    main.focus({ preventScroll: true });
    let active = true;
    let animation_frame = 0;
    let input_frame = 0;
    let stepping = false;
    let pending_elapsed_us = 0;
    let previous_time = performance.now();
    let release_renderer = () => {};
    let release_updates = () => {};
    let release_controller = () => {};
    let resize_observer: ResizeObserver | undefined;

    const apply_frame = (
      frame: BlotPresentation,
      renderer: PreviewRenderer,
    ) => {
      if (!active) return;
      presentation_reference.current = frame;
      set_presentation(frame);
      set_runtime_message(frame.observation.status.value);
      renderer.render(frame.snapshot, frame.observation.regions);
      canvas.dataset.objectCount = String(frame.snapshot.objects.length);
      canvas.dataset.objectIds = frame.snapshot.objects.map(({ id }) => id)
        .join(",");
      canvas.dataset.exitX = String(
        frame.snapshot.objects.find(({ id }) => id === 101)?.position[0] ??
          "missing",
      );
      canvas.dataset.outcome = frame.observation.outcome;
      canvas.dataset.validationErrors = String(
        renderer.validation_error_count,
      );
    };

    const initialize = async () => {
      resize_canvas(canvas);
      const controller = new DevelopmentController({
        load_source: fetch_artifact,
        create_guest: (source) =>
          create_platformer_guest(source.wasm_bytes, source.manifest_source),
        codec: blot_runtime_codec,
        observer: runtime_observer(),
        initial_query: viewport,
      });
      controller_reference.current = controller;
      release_controller = controller.subscribe(() => {
        const state = controller.snapshot();
        set_runtime_state(state.type);
        if (state.type === "failed" || state.type === "failed_with_last_good") {
          set_runtime_notice(state.reason);
        }
      });
      const frame = await controller.initialize();
      if (frame === undefined) {
        throw new Error("platformer runtime did not publish its first frame");
      }
      const assets = create_browser_platformer_assets("/assets.manifest.json");
      const resources = frame.snapshot.resources.filter((resource) =>
        resource.type === "mesh"
      );
      if (resources.length !== 1) {
        throw new Error(
          `platformer frame contains ${resources.length} meshes; expected one`,
        );
      }
      const renderer = await create_preview_renderer({
        canvas,
        meshes: [await assets.replace(resources[0])],
        model_shader_source: platformer_shader_source,
        textures: [],
      });
      if (!active) {
        renderer.dispose();
        await controller.close();
        return;
      }
      renderer_reference.current = renderer;
      set_renderer_mode(renderer.mode);
      set_gpu_adapter(renderer.adapter_description ?? "unavailable");
      if (renderer.unavailable_reason !== null) {
        set_runtime_notice(
          `WebGPU preview unavailable: ${renderer.unavailable_reason}`,
        );
      }
      release_renderer = renderer.on_unavailable((reason) => {
        if (!active) return;
        set_renderer_mode("semantic_only");
        set_runtime_notice(`WebGPU preview unavailable: ${reason}`);
      });
      apply_frame(frame, renderer);

      const input = new BrowserInputAdapter({
        keyboard_target: main,
        pointer_target: canvas,
        focus_target: globalThis,
        pointer_lock_target: document,
        get_gamepads: () => navigator.getGamepads(),
        accept_keyboard(event, pressed) {
          if (!input_map.includes(event.code)) return false;
          if (!pressed) return true;
          return !editable_keyboard_target(event.target) &&
            main.contains(document.activeElement);
        },
      });

      const advance = (current_time: number) => {
        const elapsed_us = Math.max(
          0,
          Math.round((current_time - previous_time) * 1_000),
        );
        previous_time = current_time;
        if (!playing_reference.current) {
          pending_elapsed_us = 0;
          animation_frame = requestAnimationFrame(advance);
          return;
        }
        pending_elapsed_us += elapsed_us;
        if (!stepping && pending_elapsed_us >= 50_000) {
          const actions = input_map.actions(
            input.capture(frame_id(input_frame++)),
            presentation_reference.current?.observation,
          );
          pending_elapsed_us -= 50_000;
          stepping = true;
          void controller.advance({
            elapsed_us: microseconds(50_000),
            inputs: actions,
          }).then((revision) => {
            canvas.dataset.snapshotChecksum = revision.snapshot_checksum;
            const next = controller.observation();
            if (next === undefined) {
              throw new Error("platformer advance did not publish a frame");
            }
            apply_frame(next, renderer);
            if (next.observation.outcome === "won") {
              playing_reference.current = false;
              set_playback("paused");
              pending_elapsed_us = 0;
            }
          }).catch((error) => {
            if (active) set_runtime_notice(error_message(error));
          }).finally(() => {
            stepping = false;
          });
        }
        animation_frame = requestAnimationFrame(advance);
      };
      animation_frame = requestAnimationFrame(advance);

      resize_observer = new ResizeObserver(() => {
        resize_canvas(canvas);
        void controller.resize(viewport).then((next) => {
          apply_frame(next, renderer);
        }).catch((error) => {
          if (active) set_runtime_notice(error_message(error));
        });
      });
      resize_observer.observe(canvas);

      const hot = import.meta.hot;
      if (hot) {
        let reload_queue = Promise.resolve();
        release_updates = subscribe_to_application_updates(hot, (update) => {
          reload_queue = reload_queue.then(() =>
            reload_application(
              update,
              controller,
              renderer,
              assets,
              apply_frame,
            )
          ).catch((error) => {
            if (active) set_runtime_notice(error_message(error));
          });
        });
      }

      return () => input.dispose();
    };

    let dispose_input = () => {};
    void initialize().then((dispose) => {
      if (dispose !== undefined) dispose_input = dispose;
    }).catch((error) => {
      if (!active) return;
      const message = error_message(error);
      set_runtime_state("failed");
      set_runtime_notice(message);
    });

    return () => {
      active = false;
      cancelAnimationFrame(animation_frame);
      resize_observer?.disconnect();
      dispose_input();
      release_updates();
      release_renderer();
      release_controller();
      renderer_reference.current?.dispose();
      renderer_reference.current = null;
      playing_reference.current = false;
      const controller = controller_reference.current;
      controller_reference.current = null;
      if (controller !== null) void controller.close();
    };
  }, []);

  const dispatch_action = async (action: GameAction) => {
    const controller = controller_reference.current;
    const renderer = renderer_reference.current;
    if (controller === null || renderer === null) return;
    try {
      await controller.advance({
        elapsed_us: microseconds(0),
        inputs: [action],
      });
      const next = controller.observation();
      if (next === undefined) {
        throw new Error("platformer action did not publish a frame");
      }
      presentation_reference.current = next;
      set_presentation(next);
      set_runtime_message(next.observation.status.value);
      renderer.render(next.snapshot, next.observation.regions);
    } catch (error) {
      set_runtime_notice(error_message(error));
    }
  };

  const move_exit = async () => {
    if (project === undefined) return;
    const moved = move_platformer_record(
      project,
      project.entry_level_id,
      platformer_record_id("level-exit"),
      { x: 1, y: 0 },
    );
    set_project(moved);
    set_selected_record("level-exit");
    set_runtime_message("Saving the moved exit");
    try {
      const response = await fetch(platformer_project_save_url, {
        method: "PUT",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: serialize_platformer_project(moved),
      });
      if (!response.ok) {
        throw new Error(
          `platformer project save returned ${response.status}: ${await response
            .text()}`,
        );
      }
      set_runtime_message("Exit saved; rebuilding the Blot guest");
    } catch (error) {
      set_project(project);
      set_runtime_notice(error_message(error));
    }
  };

  const reset_game = async () => {
    const controller = controller_reference.current;
    const renderer = renderer_reference.current;
    if (controller === null || renderer === null) return;
    playing_reference.current = false;
    set_playback("paused");
    try {
      const revision = await controller.reset();
      const canvas = canvas_reference.current;
      if (canvas !== null) {
        canvas.dataset.snapshotChecksum = revision.snapshot_checksum;
      }
      const next = controller.observation();
      if (next === undefined) {
        throw new Error("platformer reset did not publish a frame");
      }
      presentation_reference.current = next;
      set_presentation(next);
      set_runtime_message(next.observation.status.value);
      renderer.render(next.snapshot, next.observation.regions);
    } catch (error) {
      set_runtime_notice(error_message(error));
    }
  };

  return (
    <main
      ref={main_reference}
      className="platformer-development"
      tabIndex={0}
      data-runtime-state={runtime_state}
      data-renderer-mode={renderer_mode}
      data-gpu-adapter={gpu_adapter}
      data-outcome={presentation?.observation.outcome ?? "loading"}
      onKeyDown={(event) => {
        if (!input_map.includes(event.nativeEvent.code)) return;
        event.preventDefault();
      }}
    >
      <header className="application-header">
        <div>
          <small>Ink · classic-adventure</small>
          <h1>Platformer Development</h1>
        </div>
        <output aria-live="polite">{runtime_message}</output>
      </header>
      <div className="application-columns">
        <aside className="editor-panel">
          {project === undefined
            ? <p>Loading the platformer project…</p>
            : (
              <PlatformerWorkspace
                project={project}
                selected_record_id={selected_record}
                onMoveExit={() => void move_exit()}
                onSelectRecord={set_selected_record}
              />
            )}
        </aside>
        <section className="preview-panel" aria-label="Playable preview">
          <canvas ref={canvas_reference} aria-label="Platformer game canvas" />
          <div className="status-card">
            <strong>
              {presentation?.observation.status.label ?? "Loading"}
            </strong>
            <span>
              {presentation?.observation.status.value ?? "Starting guest"}
            </span>
          </div>
          <div className="action-controls" aria-label="Game actions">
            <button
              type="button"
              data-transport="play"
              disabled={playback === "playing"}
              onClick={() => {
                main_reference.current?.focus({ preventScroll: true });
                playing_reference.current = true;
                set_playback("playing");
              }}
            >
              Play
            </button>
            <button
              type="button"
              data-transport="reset"
              onClick={() => void reset_game()}
            >
              Reset
            </button>
            {presentation?.observation.actions.map(({ id, label, action }) => (
              <button
                key={id}
                type="button"
                data-action-id={id}
                onClick={() => void dispatch_action(action)}
              >
                {label}
              </button>
            ))}
          </div>
        </section>
      </div>
      {runtime_notice !== undefined && (
        <output className="runtime-notice" aria-live="assertive">
          {runtime_notice}
        </output>
      )}
    </main>
  );
}

async function reload_application(
  update: ApplicationUpdate,
  controller: PlatformerController,
  renderer: PreviewRenderer,
  assets: PlatformerSceneAssetStore,
  apply_frame: (frame: BlotPresentation, renderer: PreviewRenderer) => void,
): Promise<void> {
  if (update.type === "compilation_error" || update.type === "resource_error") {
    throw new Error(update.message);
  }
  await controller.reload();
  const frame = controller.observation();
  if (frame === undefined) {
    throw new Error("reloaded platformer did not publish a frame");
  }
  if (update.type === "resources") {
    const resources = frame.snapshot.resources.filter((resource) =>
      resource.type === "mesh"
    );
    if (resources.length !== 1) {
      throw new Error(
        `reloaded platformer contains ${resources.length} meshes; expected one`,
      );
    }
    renderer.replace_assets([await assets.replace(resources[0])], []);
  }
  apply_frame(frame, renderer);
}

async function fetch_artifact(): Promise<PlatformerArtifactSource> {
  const [wasm_response, manifest_response] = await Promise.all([
    fetch(`/${artifact_name}.wasm`, { cache: "no-store" }),
    fetch(`/${artifact_name}.wasm.json`, { cache: "no-store" }),
  ]);
  if (!wasm_response.ok) {
    throw new Error(`platformer Wasm returned ${wasm_response.status}`);
  }
  if (!manifest_response.ok) {
    throw new Error(`platformer manifest returned ${manifest_response.status}`);
  }
  return {
    wasm_bytes: new Uint8Array(await wasm_response.arrayBuffer()),
    manifest_source: await manifest_response.text(),
  };
}

async function load_project(): Promise<PlatformerProject> {
  const response = await fetch("/platformer-project.json", {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`platformer project returned ${response.status}`);
  }
  return parse_platformer_project(await response.text());
}

function resize_canvas(canvas: HTMLCanvasElement): void {
  const pixel_ratio = globalThis.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(canvas.clientWidth || viewport.width));
  const height = Math.max(
    1,
    Math.floor(canvas.clientHeight || viewport.height),
  );
  canvas.width = Math.floor(width * pixel_ratio);
  canvas.height = Math.floor(height * pixel_ratio);
}

function editable_keyboard_target(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;
}

function runtime_observer(): Observer {
  return new Observer({
    source: { subsystem: "platformer-development" },
    sink: no_observations,
    clock: { now_seconds: () => performance.now() / 1_000 },
  });
}

function error_message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
