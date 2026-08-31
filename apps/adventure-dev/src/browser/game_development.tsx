/// <reference types="vite/client" />

import { Button } from "@comp0/react";
import { PauseIcon, PlayIcon, StopIcon } from "@heroicons/react/24/solid";
import {
  blot_runtime_codec,
  type BlotPresentation,
  type BlotRuntimeGuest,
} from "@ink/blot/runtime.ts";
import { parse_blot_integer_data_asset } from "@ink/blot/data_asset.ts";
import type { BlotIntegerDataAsset } from "@ink/blot/data_asset.ts";
import { asset_id } from "@ink/assets/identity.ts";
import { DevelopmentController } from "@ink/development/controller.ts";
import { BrowserInputAdapter } from "@ink/input/browser.ts";
import { Observer } from "@ink/observability/observer.ts";
import type { ObservationSink } from "@ink/observability/sink.ts";
import { microseconds, type RuntimeRevision } from "@ink/runtime/session.ts";
import { frame_id } from "@ink/runtime/frame.ts";
import type {
  GameAction,
  GameObservation,
  GameViewport,
  RenderSnapshot,
  SceneResource,
} from "@ink/blot/protocol.ts";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  adventure_action_enabled,
  apply_editor_action,
  type EditorAction,
  initial_editor_state,
} from "./logic.ts";
import { GameActionControls } from "./action_controls.tsx";
import type { GameDevelopmentContext } from "./game_development_context.ts";
export type { GameDevelopmentContext } from "./game_development_context.ts";
export type {
  ContinuousKeyboardActionBinding,
  KeyboardActionBinding,
} from "./input.ts";
import {
  AdventureInputMap,
  game_surface_owns_pointer_lock,
  type KeyboardActionBinding,
} from "./input.ts";
import {
  create_debugger_observation_log,
  type DebuggerCommand,
  type DebuggerEntry,
  type GizmoVisibility,
  maximum_debugger_history_entries,
} from "@ink/development/debugger.ts";
import { DebuggerWindow } from "@ink/development/debugger_window.tsx";
import { create_game_debugger_registry } from "./game_debugger.ts";
import {
  type GameGizmoObjectRange,
  render_game_gizmos,
} from "./game_gizmos.ts";
import type { InkGameSurfaceElement } from "./game_surface.ts";
import "./game_surface.ts";
import {
  type ApplicationUpdate,
  subscribe_to_application_updates,
} from "@ink/vite/client.ts";
import {
  parse_workspace_message,
  workspace_channel_name,
  type WorkspaceMessage,
} from "./workspace_broadcast.ts";
import {
  create_renderer,
  type Renderer,
  type RenderFrameResult,
  type RenderTexture,
} from "@ink/rendering/renderer.ts";
import {
  create_browser_scene_asset_store,
  type SceneAssetStore,
} from "./scene_assets.ts";
import {
  type AdventureAudio,
  create_browser_adventure_audio,
} from "./audio.ts";
import { AdventureDevelopmentRuntimeController } from "./adventure_development_runtime.ts";
import {
  adventure_render_scene,
  type AdventureRenderAssets,
} from "./rendering.ts";
import { adventure_gate_animation } from "./gate_animation.ts";
import {
  adventure_render_technique,
  initial_adventure_presentation_settings,
  select_adventure_technique,
} from "./presentation.ts";
import "./styles.css";

const transport_button_class_name =
  "inline-flex size-9 items-center justify-center rounded-md outline-none transition-colors data-focus-visible:ring-3 data-focus-visible:ring-ring/50 data-hovered:bg-accent data-pressed:bg-secondary disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4";
const keyboard_action_ids = Object.freeze([
  "forward-start",
  "forward-stop",
  "backward-start",
  "backward-stop",
  "left-start",
  "left-stop",
  "right-start",
  "right-stop",
  "orbit-left",
  "orbit-right",
  "restart",
]);

export interface GameDevelopmentProps {
  readonly assets: {
    readonly wasm_url: string;
    readonly manifest_url: string;
    readonly asset_manifest_url: string;
  };
  readonly load_artifact: (
    wasm_bytes: Uint8Array,
    manifest_source: string,
    data_assets: readonly BlotIntegerDataAsset[],
  ) => Promise<BlotRuntimeGuest>;
  readonly keyboard_actions?: Readonly<Record<string, KeyboardActionBinding>>;
  readonly logical_viewport?: GameViewport;
  readonly always_enable_semantic_buttons?: boolean;
  readonly auto_play?: boolean;
  readonly debugger_commands?: readonly DebuggerCommand[];
  readonly gizmo_object_ranges?: readonly GameGizmoObjectRange[];
  readonly show_debugger?: boolean;
  readonly show_metrics?: boolean;
  readonly show_transport?: boolean;
  readonly workspace_channel?: string;
  readonly pointer_action?: (
    input: GamePointerInput,
  ) => GameAction | undefined;
  readonly pointer_lock?: {
    readonly actions_for_motion: (
      input: GamePointerMotionInput,
    ) => readonly string[];
    readonly primary_action_id?: string;
  };
  readonly render_editor?: (context: GameDevelopmentContext) => ReactNode;
}

export interface GamePointerInput {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly observation: GameObservation;
}

export interface GamePointerMotionInput {
  readonly movement_x: number;
  readonly movement_y: number;
  readonly observation: GameObservation;
}

interface AdventureArtifactSource {
  readonly wasm_bytes: Uint8Array;
  readonly manifest_source: string;
  readonly data_assets: readonly BlotIntegerDataAsset[];
}

interface AdventureGameController {
  readonly observation: () => BlotPresentation | undefined;
  initialize(): Promise<BlotPresentation | undefined>;
  advance(step: {
    readonly elapsed_us: ReturnType<typeof microseconds>;
    readonly inputs: readonly GameAction[];
  }): Promise<RuntimeRevision>;
  resize(query: GameViewport): Promise<BlotPresentation>;
  reset(): Promise<RuntimeRevision>;
  reload(): Promise<{ readonly preserved: boolean }>;
  close(): Promise<void>;
}

export const GameDevelopment = function game_development(
  {
    assets,
    always_enable_semantic_buttons = false,
    auto_play = false,
    debugger_commands = [],
    gizmo_object_ranges = [],
    keyboard_actions,
    load_artifact,
    logical_viewport,
    pointer_action,
    pointer_lock,
    render_editor,
    show_debugger = false,
    show_metrics = true,
    show_transport = true,
    workspace_channel,
  }: GameDevelopmentProps,
) {
  "use memo";

  const [editor_state, set_editor_state] = useState(
    auto_play ? { playback: "playing" as const } : initial_editor_state,
  );
  const [game_observation, set_game_observation] = useState<
    GameObservation
  >();
  const [runtime_message, set_runtime_message] = useState("Loading game");
  const [runtime_notice, set_runtime_notice] = useState<string | null>(null);
  const [runtime_state, set_runtime_state] = useState<
    "loading" | "ready" | "failed"
  >("loading");
  const [presentation_settings, set_presentation_settings] = useState(
    initial_adventure_presentation_settings,
  );
  const presentation_settings_reference = useRef(
    initial_adventure_presentation_settings,
  );
  const [renderer_generation, set_renderer_generation] = useState(0);
  const [gizmo_visibility, set_gizmo_visibility] = useState<GizmoVisibility>(
    "none",
  );
  const [debugger_open, set_debugger_open] = useState(show_debugger);
  const next_debugger_entry_id_reference = useRef(0);
  const [runtime_debugger_entries, set_runtime_debugger_entries] = useState<
    readonly DebuggerEntry[]
  >([]);
  const [runtime_observation_log] = useState(() =>
    create_debugger_observation_log({
      capacity: maximum_debugger_history_entries,
      record(action) {
        const entry: DebuggerEntry = {
          id: next_debugger_entry_id_reference.current,
          kind: action.kind,
          message: action.message,
        };
        next_debugger_entry_id_reference.current += 1;
        set_runtime_debugger_entries((current) =>
          Object.freeze(
            [...current, entry].slice(-maximum_debugger_history_entries),
          )
        );
      },
    })
  );
  const gizmo_visibility_reference = useRef<GizmoVisibility>("none");
  const latest_snapshot_reference = useRef<RenderSnapshot | undefined>(
    undefined,
  );
  const observation_reference = useRef<GameObservation | undefined>(undefined);
  const main_reference = useRef<HTMLElement>(null);
  const semantic_update_time_reference = useRef(0);
  const surface_reference = useRef<InkGameSurfaceElement>(null);
  const controller_reference = useRef<AdventureGameController | null>(
    null,
  );
  const development_controller_reference = useRef<
    AdventureDevelopmentRuntimeController | null
  >(null);
  const renderer_reference = useRef<Renderer | null>(null);
  const render_assets_reference = useRef<AdventureRenderAssets | null>(null);
  const scene_asset_store_reference = useRef<SceneAssetStore | null>(null);
  const audio_reference = useRef<AdventureAudio | null>(null);
  const applied_effect_sequence_reference = useRef<number | undefined>(
    undefined,
  );
  const browser_input_reference = useRef<BrowserInputAdapter | null>(null);
  const input_map_reference = useRef<AdventureInputMap | null>(null);
  const input_frame_reference = useRef(0);
  const resource_fingerprint_reference = useRef<string | null>(null);
  const hot_reload_error_reference = useRef<string | null>(null);
  const workspace_channel_reference = useRef<BroadcastChannel | null>(null);
  const pending_workspace_messages_reference = useRef<WorkspaceMessage[]>([]);
  const load_artifact_reference = useRef(load_artifact);
  const render_editor_reference = useRef(render_editor);
  const playback_reference = useRef(editor_state.playback);
  const painting_pointer_reference = useRef<number | null>(null);
  const painted_action_reference = useRef<string | null>(null);
  const metrics_output_reference = useRef<HTMLOutputElement>(null);
  const presentation_output_reference = useRef<HTMLOutputElement>(null);
  const renderer_generation_reference = useRef(0);
  const frame_metrics_reference = useRef({
    frames: 0,
    rendered_at: performance.now(),
    sampled_at: performance.now(),
  });
  const wasm_url = assets.wasm_url;
  const manifest_url = assets.manifest_url;
  const asset_manifest_url = assets.asset_manifest_url;
  const viewport_reference = useRef<GameViewport>(
    logical_viewport ?? { width: 960, height: 540 },
  );

  useEffect(() => {
    if (render_editor) return;
    main_reference.current?.focus({ preventScroll: true });
  }, [render_editor]);

  useEffect(() => {
    load_artifact_reference.current = load_artifact;
    render_editor_reference.current = render_editor;
  }, [load_artifact, render_editor]);

  useEffect(() => {
    playback_reference.current = editor_state.playback;
    surface_reference.current?.set_gameplay_enabled(
      always_enable_semantic_buttons || editor_state.playback === "playing",
    );
  }, [editor_state.playback]);

  useEffect(() => {
    if (!keyboard_actions) return;
    const main = main_reference.current;
    const surface = surface_reference.current;
    if (main === null || surface === null) return;
    const input_map = new AdventureInputMap(keyboard_actions);
    const input = new BrowserInputAdapter({
      keyboard_target: main,
      pointer_target: surface.canvas,
      focus_target: globalThis,
      pointer_lock_target: document,
      pointer_locked: () =>
        game_surface_owns_pointer_lock(
          surface_reference.current,
          document.pointerLockElement,
        ),
      accept_keyboard(event, pressed) {
        if (!pressed) return input_map.includes(event.code);
        return input_map.includes(event.code) &&
          !editable_keyboard_target(event.target) &&
          (main.contains(document.activeElement) ||
            game_surface_owns_pointer_lock(
              surface_reference.current,
              document.pointerLockElement,
            ));
      },
    });
    input_map_reference.current = input_map;
    browser_input_reference.current = input;
    return () => {
      input.dispose();
      if (browser_input_reference.current === input) {
        browser_input_reference.current = null;
        input_map_reference.current = null;
      }
    };
  }, [keyboard_actions]);

  useEffect(() => {
    const surface = surface_reference.current;
    if (!surface) return;
    const canvas = surface.canvas;
    let active = true;
    let active_audio: AdventureAudio | undefined;

    const start_game = async () => {
      const audio = create_browser_adventure_audio(
        adventure_audio_observer(runtime_observation_log),
      );
      active_audio = audio;
      audio_reference.current = audio;
      surface.dataset.audioState = audio.state.type;
      const viewport = logical_viewport ?? canvas_viewport(canvas);
      viewport_reference.current = viewport;
      const scene_asset_store = create_browser_scene_asset_store(
        asset_manifest_url,
      );
      scene_asset_store_reference.current = scene_asset_store;
      const observer = runtime_observer(runtime_observation_log);
      const development_controller = import.meta.hot === undefined
        ? undefined
        : new AdventureDevelopmentRuntimeController({
          artifacts: browser_development_artifacts(),
          initial_query: viewport,
          load_level_asset: () => load_level_asset(scene_asset_store),
          load_revision: () => fetch_development_revision(wasm_url),
          load_runtime_module: import_development_runtime,
          observer,
        });
      const controller: AdventureGameController = development_controller ??
        new DevelopmentController({
          load_source: () =>
            fetch_game_artifact({
              wasm_url,
              manifest_url,
            }, scene_asset_store),
          create_guest: (source) =>
            load_artifact_reference.current(
              source.wasm_bytes,
              source.manifest_source,
              source.data_assets,
            ),
          codec: blot_runtime_codec,
          observer,
          initial_query: viewport,
        });
      development_controller_reference.current = development_controller ??
        null;
      publish_development_evidence(
        main_reference.current,
        development_controller === undefined
          ? { type: "production" }
          : { type: "loading" },
      );
      const frame = await controller.initialize();
      if (frame === undefined) {
        throw new Error("dungeon runtime did not publish its first frame");
      }
      let renderer: Renderer | null = null;
      try {
        const render_assets = await load_render_assets(
          frame.snapshot.resources,
          scene_asset_store,
        );
        render_assets_reference.current = render_assets;
        renderer = await create_renderer({
          canvas,
          technique: adventure_render_technique(
            initial_adventure_presentation_settings,
          ),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(
          "3D assets unavailable; semantic game remains active",
          error,
        );
        set_runtime_notice(
          renderer_notice(`3D assets failed to load: ${reason}`),
        );
      }
      resource_fingerprint_reference.current = resource_fingerprint(
        frame.snapshot.resources,
      );
      if (!active) {
        await controller.close();
        renderer?.dispose();
        return;
      }
      controller_reference.current = controller;
      if (development_controller !== undefined) {
        publish_development_evidence(main_reference.current, {
          type: "ready",
          revision: development_controller.active_revision(),
          entry_retained: false,
          state_preserved: false,
        });
      }
      renderer_reference.current = renderer;
      surface.dataset.gpuAdapter = renderer?.adapter_description ??
        "unavailable";
      const main = main_reference.current;
      if (main !== null) {
        main.dataset.adapter = renderer?.adapter_description ?? "unavailable";
        main.dataset.rendererStatus = renderer?.status.type ?? "unavailable";
        main.dataset.validationErrors = String(
          renderer?.validation_error_count ?? 0,
        );
      }
      if (renderer !== null) {
        renderer_generation_reference.current += 1;
        set_renderer_generation(renderer_generation_reference.current);
      }
      await apply_frame(frame, renderer);
      await flush_pending_workspace_messages();
    };

    void start_game().catch(
      (error) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        set_runtime_message(message);
        set_runtime_notice(`Game failed to start: ${message}`);
        set_runtime_state("failed");
      },
    );

    return () => {
      active = false;
      renderer_reference.current?.dispose();
      const controller = controller_reference.current;
      if (controller) void controller.close();
      controller_reference.current = null;
      development_controller_reference.current = null;
      if (audio_reference.current === active_audio) {
        audio_reference.current = null;
      }
      if (active_audio) void active_audio.close();
    };
  }, [asset_manifest_url, manifest_url, wasm_url]);

  useEffect(() => {
    let active = true;
    let reload_queue = Promise.resolve();
    const reload_game = async (update: ApplicationUpdate) => {
      if (!active) return;
      if (
        update.type === "compilation_error" || update.type === "resource_error"
      ) {
        const message = update.type === "compilation_error"
          ? `Game compilation failed: ${update.message}`
          : `Game resource reload failed: ${update.message}`;
        hot_reload_error_reference.current = message;
        set_runtime_message(message);
        set_runtime_notice(message);
        const development = development_controller_reference.current;
        publish_development_evidence(
          main_reference.current,
          development === null ? { type: "production" } : {
            type: "failed",
            revision: development.active_revision(),
          },
        );
        return;
      }
      const controller = controller_reference.current;
      if (!controller) return;
      const development = development_controller_reference.current;
      try {
        if (development !== null) {
          publish_development_evidence(main_reference.current, {
            type: "activating",
            revision: development.active_revision(),
          });
        }
        const reloaded = await controller.reload();
        if (!active) return;
        const frame = controller.observation();
        if (frame === undefined) {
          throw new Error("reloaded adventure did not publish a frame");
        }
        const renderer = renderer_reference.current;
        await apply_frame(
          frame,
          renderer,
          { reload_resources: true },
        );
        hot_reload_error_reference.current = null;
        if (development !== null) {
          const activation = development.activation();
          if (activation === undefined) {
            throw new Error(
              "adventure development activation did not publish evidence",
            );
          }
          publish_development_evidence(main_reference.current, {
            type: "ready",
            revision: activation.revision,
            entry_retained: activation.entry_retained,
            state_preserved: reloaded.preserved,
          });
        }
        if (renderer !== null) set_runtime_notice(null);
        set_runtime_message(
          update.type === "resources"
            ? `Resources reloaded. ${frame.observation.status.value}`
            : reloaded.preserved
            ? `Game reloaded; state preserved. ${frame.observation.status.value}`
            : `Game reloaded with an incompatible schema; state reset. ${frame.observation.status.value}`,
        );
      } catch (error) {
        if (active) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          const notice = `Game reload failed: ${message}`;
          hot_reload_error_reference.current = notice;
          set_runtime_message(notice);
          set_runtime_notice(notice);
          if (development !== null) {
            publish_development_evidence(main_reference.current, {
              type: "failed",
              revision: development.active_revision(),
            });
          }
        }
      }
    };

    const hot = import.meta.hot;
    if (!hot) return;
    const unsubscribe = subscribe_to_application_updates(
      hot,
      (update) => {
        reload_queue = reload_queue.then(() => reload_game(update));
      },
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, [manifest_url, wasm_url]);

  useEffect(() => {
    if (editor_state.playback !== "playing") return;

    let previous_time = performance.now();
    let pending_delta_us = 0;
    let stepping = false;
    let animation_frame = requestAnimationFrame(advance);
    function advance(current_time: number) {
      const delta_seconds = (current_time - previous_time) / 1000;
      previous_time = current_time;
      pending_delta_us += Math.max(
        0,
        Math.round(delta_seconds * 1_000_000),
      );
      const controller = controller_reference.current;
      if (!stepping && controller) {
        const browser_input = browser_input_reference.current;
        const input_map = input_map_reference.current;
        const surface = surface_reference.current;
        const normalized_actions = browser_input && input_map
          ? input_map.actions(
            browser_input.capture(frame_id(input_frame_reference.current++)),
            observation_reference.current,
            main_reference.current?.contains(document.activeElement) ===
                true ||
              game_surface_owns_pointer_lock(
                surface,
                document.pointerLockElement,
              )
              ? "active"
              : "release_only",
          )
          : [];
        const delta_us = pending_delta_us;
        pending_delta_us = 0;
        stepping = true;
        void controller.advance({
          elapsed_us: microseconds(delta_us),
          inputs: normalized_actions,
        }).then((revision) => {
          publish_runtime_revision(revision);
          const frame = controller.observation();
          if (frame === undefined) {
            throw new Error("adventure advance did not publish a frame");
          }
          return apply_frame(frame, renderer_reference.current, {
            sample_semantics: true,
          });
        }).catch(report_runtime_error).finally(() => {
          stepping = false;
        });
      }
      animation_frame = requestAnimationFrame(advance);
    }
    return () => cancelAnimationFrame(animation_frame);
  }, [editor_state.playback]);

  useEffect(() => {
    const surface = surface_reference.current;
    if (!surface) return;
    const canvas = surface.canvas;
    const resize_canvas = async () => {
      const pixel_ratio = globalThis.devicePixelRatio || 1;
      const css_viewport = canvas_viewport(canvas);
      const viewport = logical_viewport ?? css_viewport;
      canvas.width = Math.max(
        1,
        Math.floor(
          (logical_viewport?.width ?? css_viewport.width) * pixel_ratio,
        ),
      );
      canvas.height = Math.max(
        1,
        Math.floor(
          (logical_viewport?.height ?? css_viewport.height) * pixel_ratio,
        ),
      );
      const controller = controller_reference.current;
      if (!controller) return;
      try {
        viewport_reference.current = viewport;
        const frame = await controller.resize(viewport);
        const renderer = renderer_reference.current;
        await apply_frame(frame, renderer);
      } catch (error) {
        report_runtime_error(error);
      }
    };
    const observer = new ResizeObserver(resize_canvas);
    observer.observe(canvas);
    void resize_canvas();
    return () => observer.disconnect();
  }, []);

  const apply_transport = async (action: EditorAction) => {
    const next_editor_state = apply_editor_action(
      { playback: playback_reference.current },
      action,
    );
    playback_reference.current = next_editor_state.playback;
    surface_reference.current?.set_gameplay_enabled(
      always_enable_semantic_buttons ||
        next_editor_state.playback === "playing",
    );
    set_editor_state(next_editor_state);
    const now = performance.now();
    frame_metrics_reference.current = {
      frames: 0,
      rendered_at: now,
      sampled_at: now,
    };
    if (metrics_output_reference.current) {
      metrics_output_reference.current.textContent = "FPS --";
    }
    if (action.type !== "stop") return;
    const controller = controller_reference.current;
    if (!controller) return;
    try {
      const revision = await controller.reset();
      publish_runtime_revision(revision);
      const frame = controller.observation();
      if (frame === undefined) {
        throw new Error("reset adventure did not publish a frame");
      }
      const renderer = renderer_reference.current;
      await apply_frame(frame, renderer);
    } catch (error) {
      report_runtime_error(error);
    }
  };

  const dispatch_session_actions = async (actions: readonly GameAction[]) => {
    const controller = controller_reference.current;
    if (!controller || actions.length === 0) return;
    try {
      const revision = await controller.advance({
        elapsed_us: microseconds(0),
        inputs: actions,
      });
      publish_runtime_revision(revision);
      const frame = controller.observation();
      if (frame === undefined) {
        throw new Error("adventure action did not publish a frame");
      }
      const renderer = renderer_reference.current;
      await apply_frame(frame, renderer);
    } catch (error) {
      report_runtime_error(error);
    }
  };

  const dispatch_session_action = async (action: GameAction) => {
    await dispatch_session_actions([action]);
  };

  const apply_game_action = async (action: GameAction) => {
    if (!adventure_action_enabled(playback_reference.current, action)) return;
    await dispatch_session_action(action);
  };

  const broadcast_workspace_message = (message: WorkspaceMessage) => {
    workspace_channel_reference.current?.postMessage(message);
  };

  const dispatch_transport = async (action: EditorAction) => {
    await apply_transport(action);
    broadcast_workspace_message({ type: "transport", action });
  };

  const dispatch_game_action = async (action: GameAction) => {
    const audio = audio_reference.current;
    if (audio) {
      const state = await audio.activate();
      const surface = surface_reference.current;
      if (surface) surface.dataset.audioState = state.type;
    }
    await apply_game_action(action);
    broadcast_workspace_message({ type: "game_action", action });
  };

  const dispatch_preview_update:
    GameDevelopmentContext["dispatch_preview_update"] = async (action) => {
      await dispatch_session_action(action);
      broadcast_workspace_message({ type: "preview_update", action });
    };

  const set_host_camera: GameDevelopmentContext["set_host_camera"] = (
    camera,
  ) => {
    const current = presentation_settings_reference.current;
    const next = Object.freeze({
      ...current,
      host_camera: Object.freeze(camera),
    });
    presentation_settings_reference.current = next;
    set_presentation_settings(next);
    const renderer = renderer_reference.current;
    const snapshot = latest_snapshot_reference.current;
    if (renderer === null || snapshot === undefined) return;
    render_snapshot(
      renderer,
      snapshot,
      observation_reference.current?.sequence ?? 0,
    );
  };

  const apply_workspace_message = async (message: WorkspaceMessage) => {
    switch (message.type) {
      case "transport":
        await apply_transport(message.action);
        return;
      case "game_action":
        await apply_game_action(message.action);
        return;
      case "preview_update":
        await dispatch_session_action(message.action);
        return;
    }
  };

  const flush_pending_workspace_messages = async () => {
    const messages = pending_workspace_messages_reference.current.splice(0);
    for (const message of messages) await apply_workspace_message(message);
  };

  useEffect(() => {
    if (!workspace_channel) return;
    if (typeof BroadcastChannel === "undefined") {
      set_runtime_notice(
        `Workspace ${
          JSON.stringify(workspace_channel)
        } cannot synchronize because BroadcastChannel is unavailable`,
      );
      return;
    }
    const channel = new BroadcastChannel(
      workspace_channel_name(workspace_channel),
    );
    workspace_channel_reference.current = channel;
    channel.addEventListener("message", (event) => {
      let message: WorkspaceMessage;
      try {
        message = parse_workspace_message(event.data);
      } catch (error) {
        report_runtime_error(error);
        return;
      }
      if (!controller_reference.current) {
        pending_workspace_messages_reference.current.push(message);
        return;
      }
      void apply_workspace_message(message).catch(report_runtime_error);
    });
    channel.addEventListener("messageerror", () => {
      report_runtime_error(
        new Error(
          `Workspace ${
            JSON.stringify(workspace_channel)
          } received an unreadable broadcast`,
        ),
      );
    });
    return () => {
      workspace_channel_reference.current = null;
      channel.close();
    };
  }, [workspace_channel]);

  const dispatch_action_id = async (action_id: string) => {
    const action = observation_reference.current?.actions.find((candidate) =>
      candidate.id === action_id
    )?.action;
    if (!action) return;
    await dispatch_game_action(action);
  };

  const pointer_action_at = (
    event: ReactPointerEvent<InkGameSurfaceElement>,
  ): GameAction | undefined => {
    if (playback_reference.current !== "playing") return undefined;
    const observation = observation_reference.current;
    if (!pointer_action || !observation) return undefined;
    const bounds = event.currentTarget.getBoundingClientRect();
    return pointer_action({
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
      width: bounds.width,
      height: bounds.height,
      observation,
    });
  };

  const dispatch_pointer_action = (
    event: ReactPointerEvent<InkGameSurfaceElement>,
  ) => {
    const action = pointer_action_at(event);
    if (!action) return;
    const fingerprint = JSON.stringify(action);
    if (fingerprint === painted_action_reference.current) return;
    painted_action_reference.current = fingerprint;
    void dispatch_game_action(action);
  };

  const publish_runtime_revision = (revision: RuntimeRevision) => {
    const main = main_reference.current;
    if (main === null) return;
    main.dataset.runtimeSequence = String(revision.sequence);
    main.dataset.snapshotChecksum = revision.snapshot_checksum;
  };

  const render_snapshot = (
    renderer: Renderer | null,
    snapshot: RenderSnapshot,
    revision: number,
  ) => {
    if (renderer === null) return;
    const surface = surface_reference.current;
    const render_assets = render_assets_reference.current;
    if (surface === null || render_assets === null) return;
    try {
      const viewport = {
        width: Math.max(1, surface.canvas.clientWidth),
        height: Math.max(1, surface.canvas.clientHeight),
      };
      const scene = adventure_render_scene(
        snapshot,
        render_assets,
        revision,
        presentation_settings_reference.current,
      );
      const gate_animation = adventure_gate_animation(snapshot);
      const rendered_gate = scene.hierarchy.nodes.find(({ id }) =>
        id.index === 106
      );
      if (rendered_gate === undefined) {
        throw new Error("adventure render scene omitted animated oak gate 106");
      }
      const frame = renderer.render(scene);
      const pick = renderer.pick(scene, {
        x: viewport.width / 2,
        y: viewport.height / 2,
      });
      const gate_pick = renderer.pick(scene, {
        x: viewport.width * 0.55,
        y: viewport.height * 0.38,
      });
      const main = main_reference.current;
      if (main !== null) {
        publish_renderer_evidence(main, renderer, frame);
        main.dataset.centerPick = pick.type === "hit" ? pick.object_id : "miss";
        main.dataset.gatePick = gate_pick.type === "hit"
          ? gate_pick.object_id
          : "miss";
        main.dataset.gateAnimationTime = String(gate_animation.sample_time);
        main.dataset.gateRenderedVisible = String(rendered_gate.active);
        main.dataset.gateRenderPosition = JSON.stringify([
          rendered_gate.local_transform.position.x,
          rendered_gate.local_transform.position.y,
          rendered_gate.local_transform.position.z,
        ]);
        main.dataset.gateRenderRotationY = String(
          2 * Math.atan2(
            rendered_gate.local_transform.rotation.y,
            rendered_gate.local_transform.rotation.w,
          ),
        );
      }
      const output = presentation_output_reference.current;
      if (output !== null) output.textContent = frame_label(frame);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (renderer_reference.current === renderer) {
        renderer_reference.current = null;
      }
      renderer.dispose();
      const main = main_reference.current;
      if (main !== null) {
        main.dataset.rendererStatus = "device_error";
        main.dataset.rendererFailure = reason;
      }
      set_runtime_notice(renderer_notice(reason));
    }
  };

  const debugger_registry = create_game_debugger_registry({
    additional_commands: debugger_commands,
    dispatch_game_action,
    dispatch_transport,
    read_status: () =>
      JSON.stringify(
        observation_reference.current?.status ?? { status: "loading" },
      ),
    set_gizmo_visibility(visibility) {
      gizmo_visibility_reference.current = visibility;
      set_gizmo_visibility(visibility);
      const renderer = renderer_reference.current;
      const snapshot = latest_snapshot_reference.current;
      if (!renderer || !snapshot) return;
      render_snapshot(
        renderer,
        render_game_gizmos(snapshot, gizmo_object_ranges, visibility),
        observation_reference.current?.sequence ?? 0,
      );
    },
  });

  const apply_frame = async (
    frame: BlotPresentation,
    renderer: Renderer | null,
    options: {
      readonly reload_resources?: true;
      readonly sample_semantics?: true;
    } = {},
  ) => {
    latest_snapshot_reference.current = frame.snapshot;
    observation_reference.current = frame.observation;
    const main = main_reference.current;
    if (main !== null) {
      main.dataset.semanticObservation = JSON.stringify(frame.observation);
      main.dataset.blotCamera = frame.snapshot.camera.type;
      main.dataset.blotEnvironment = JSON.stringify(frame.snapshot.environment);
      main.dataset.gateVisible = String(
        frame.snapshot.objects.find(({ id }) => id === 106)?.visible ?? false,
      );
      main.dataset.keyVisible = String(
        frame.snapshot.objects.find(({ id }) => id === 11)?.visible ?? false,
      );
      main.dataset.playerPosition = JSON.stringify(
        frame.snapshot.objects.find(({ id }) => id === 10)?.position ?? null,
      );
    }
    const audio = audio_reference.current;
    if (
      audio !== null &&
      applied_effect_sequence_reference.current !== frame.observation.sequence
    ) {
      for (const effect of frame.effects) {
        switch (effect.type) {
          case "play_audio":
            if (main !== null) {
              main.dataset.spatialAudio = JSON.stringify(
                audio.play(effect.cue, frame.snapshot),
              );
            } else {
              audio.play(effect.cue, frame.snapshot);
            }
            break;
        }
      }
      applied_effect_sequence_reference.current = frame.observation.sequence;
    }
    if (audio && surface_reference.current) {
      surface_reference.current.dataset.audioState = audio.state.type;
    }
    const current_time = performance.now();
    const update_semantics = !options.sample_semantics ||
      current_time - semantic_update_time_reference.current >= 250;
    if (update_semantics) {
      semantic_update_time_reference.current = current_time;
      surface_reference.current?.update_ui(
        frame.observation,
        dispatch_game_action,
      );
      set_game_observation(frame.observation);
    }

    let active_renderer = renderer === renderer_reference.current
      ? renderer
      : null;
    const next_fingerprint = resource_fingerprint(frame.snapshot.resources);
    if (
      active_renderer !== null &&
      (options.reload_resources ||
        next_fingerprint !== resource_fingerprint_reference.current)
    ) {
      const resource_renderer = active_renderer;
      try {
        const render_assets = await load_render_assets(
          frame.snapshot.resources,
          required_scene_asset_store(scene_asset_store_reference.current),
        );
        if (resource_renderer === renderer_reference.current) {
          render_assets_reference.current = render_assets;
          resource_fingerprint_reference.current = next_fingerprint;
        } else {
          active_renderer = null;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (renderer_reference.current === resource_renderer) {
          renderer_reference.current = null;
        }
        resource_renderer.dispose();
        active_renderer = null;
        if (main !== null) {
          main.dataset.rendererStatus = "device_error";
          main.dataset.rendererFailure = reason;
        }
        set_runtime_notice(renderer_notice(reason));
      }
    }
    render_snapshot(
      active_renderer,
      render_game_gizmos(
        frame.snapshot,
        gizmo_object_ranges,
        gizmo_visibility_reference.current,
      ),
      frame.observation.sequence,
    );
    let metrics = frame_metrics_reference.current;
    if (current_time - metrics.rendered_at > 250) {
      metrics = {
        frames: 0,
        rendered_at: current_time,
        sampled_at: current_time,
      };
      frame_metrics_reference.current = metrics;
      if (metrics_output_reference.current) {
        metrics_output_reference.current.textContent = "FPS --";
      }
    }
    metrics.rendered_at = current_time;
    metrics.frames += 1;
    const elapsed = current_time - metrics.sampled_at;
    if (elapsed >= 500) {
      if (metrics_output_reference.current) {
        const frames_per_second = Math.round(metrics.frames * 1_000 / elapsed);
        metrics_output_reference.current.textContent =
          `FPS ${frames_per_second}`;
      }
      metrics.frames = 0;
      metrics.sampled_at = current_time;
    }
    set_runtime_message(frame.observation.status.value);
    set_runtime_state("ready");
    if (
      renderer_reference.current !== null &&
      hot_reload_error_reference.current === null
    ) {
      set_runtime_notice(null);
    }
  };

  const report_runtime_error = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    set_runtime_message(message);
    set_runtime_notice(`Game runtime failed: ${message}`);
  };

  const select_render_technique = (
    technique: "raster" | "path_traced",
  ) => {
    const current = presentation_settings_reference.current;
    const next = select_adventure_technique(
      current,
      technique,
    );
    if (next === current) return;
    const renderer = renderer_reference.current;
    if (renderer === null) return;
    try {
      renderer.set_technique(adventure_render_technique(next));
      presentation_settings_reference.current = next;
      set_presentation_settings(next);
      const snapshot = latest_snapshot_reference.current;
      if (snapshot !== undefined) {
        render_snapshot(
          renderer,
          snapshot,
          observation_reference.current?.sequence ?? 0,
        );
      }
    } catch (error) {
      report_runtime_error(error);
    }
  };

  useEffect(() => {
    if (
      presentation_settings.technique !== "path_traced" ||
      renderer_generation === 0
    ) return;
    const renderer = renderer_reference.current;
    if (renderer === null) return;
    let animation_frame = requestAnimationFrame(render_next_sample);
    function render_next_sample() {
      if (renderer_reference.current !== renderer) return;
      const snapshot = latest_snapshot_reference.current;
      if (snapshot !== undefined) {
        render_snapshot(
          renderer,
          snapshot,
          observation_reference.current?.sequence ?? 0,
        );
      }
      if (renderer_reference.current === renderer) {
        animation_frame = requestAnimationFrame(render_next_sample);
      }
    }
    return () => cancelAnimationFrame(animation_frame);
  }, [presentation_settings.technique, renderer_generation]);

  return (
    <main
      ref={main_reference}
      className="relative h-svh w-screen overflow-hidden bg-black"
      data-host-camera={JSON.stringify(presentation_settings.host_camera)}
      data-render-technique={presentation_settings.technique}
      data-renderer-generation={renderer_generation}
      data-runtime-state={runtime_state}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.nativeEvent.code !== "Backquote") {
          if (input_map_reference.current?.includes(event.nativeEvent.code)) {
            event.preventDefault();
          }
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (debugger_open) {
          set_debugger_open(false);
          event.currentTarget.focus();
          return;
        }
        set_debugger_open(true);
      }}
    >
      <section className="absolute inset-0" aria-label="Game preview">
        <ink-adventure-surface
          ref={surface_reference}
          className="block size-full"
          onPointerDown={(event) => {
            main_reference.current?.focus({ preventScroll: true });
            if (event.button !== 0 || semantic_pointer_event(event)) return;
            if (
              pointer_lock && playback_reference.current === "playing"
            ) {
              event.preventDefault();
              const surface = event.currentTarget;
              const canvas = event.currentTarget.canvas;
              if (
                game_surface_owns_pointer_lock(
                  surface,
                  document.pointerLockElement,
                )
              ) {
                if (pointer_lock.primary_action_id) {
                  void dispatch_action_id(pointer_lock.primary_action_id);
                }
                return;
              }
              void canvas.requestPointerLock().catch(
                report_runtime_error,
              );
              return;
            }
            const action = pointer_action_at(event);
            if (!action) return;
            event.preventDefault();
            painting_pointer_reference.current = event.pointerId;
            painted_action_reference.current = null;
            event.currentTarget.setPointerCapture(event.pointerId);
            dispatch_pointer_action(event);
          }}
          onPointerMove={(event) => {
            if (
              pointer_lock &&
              game_surface_owns_pointer_lock(
                event.currentTarget,
                document.pointerLockElement,
              )
            ) {
              const observation = observation_reference.current;
              if (!observation) return;
              const action_ids = pointer_lock.actions_for_motion({
                movement_x: event.movementX,
                movement_y: event.movementY,
                observation,
              });
              for (const action_id of action_ids) {
                void dispatch_action_id(action_id);
              }
              return;
            }
            if (
              painting_pointer_reference.current !== event.pointerId ||
              (event.buttons & 1) === 0
            ) return;
            dispatch_pointer_action(event);
          }}
          onPointerUp={(event) => {
            if (painting_pointer_reference.current !== event.pointerId) return;
            painting_pointer_reference.current = null;
            painted_action_reference.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            painting_pointer_reference.current = null;
            painted_action_reference.current = null;
          }}
        />
        <output className="sr-only" aria-live="polite">
          {runtime_message}
        </output>
        {runtime_notice && (
          <output className="runtime-notice" aria-live="polite">
            {runtime_notice}
          </output>
        )}
      </section>

      {show_metrics && (
        <output
          ref={metrics_output_reference}
          className="engine-metrics"
          aria-label="Rendering performance"
        >
          FPS --
        </output>
      )}

      <aside
        className="render-technique-controls"
        aria-label="Rendering technique"
      >
        <div role="group" aria-label="Rendering technique">
          <Button
            type="button"
            aria-pressed={presentation_settings.technique === "raster"}
            disabled={renderer_generation === 0}
            onClick={() => select_render_technique("raster")}
          >
            Raster
          </Button>
          <Button
            type="button"
            aria-pressed={presentation_settings.technique === "path_traced"}
            disabled={renderer_generation === 0}
            onClick={() => select_render_technique("path_traced")}
          >
            Path traced
          </Button>
        </div>
        <output
          ref={presentation_output_reference}
          aria-label="Rendering progress"
        >
          Raster
        </output>
      </aside>

      {debugger_open && (
        <DebuggerWindow
          commands={debugger_registry}
          runtime_entries={runtime_debugger_entries}
          runtime_message={runtime_message}
          on_clear={() => {
            runtime_observation_log.clear();
            set_runtime_debugger_entries([]);
          }}
          on_close={() => {
            set_debugger_open(false);
            main_reference.current?.focus();
          }}
        />
      )}

      {render_editor?.({
        observation: game_observation,
        playback: editor_state.playback,
        can_interact: editor_state.playback === "playing",
        gizmo_visibility,
        dispatch_game_action,
        dispatch_preview_update,
        dispatch_transport,
        set_host_camera,
      })}

      {!render_editor && (
        <GameActionControls
          observation={game_observation}
          can_interact={editor_state.playback === "playing"}
          dispatch_game_action={dispatch_game_action}
          hidden_action_ids={keyboard_action_ids}
        />
      )}

      {show_transport && (
        <div className="transport-controls absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-1 rounded-lg border border-border bg-background/90 p-1 shadow-lg backdrop-blur-sm">
          <Button
            type="button"
            className={`${transport_button_class_name} ${
              editor_state.playback === "playing" ? "bg-secondary" : ""
            }`}
            disabled={editor_state.playback === "playing"}
            aria-label="Play"
            title="Play"
            onClick={(event) => {
              event.currentTarget.closest("main")?.focus();
              void dispatch_transport({ type: "play" });
            }}
          >
            <PlayIcon />
          </Button>
          <Button
            type="button"
            className={`${transport_button_class_name} ${
              editor_state.playback === "paused" ? "bg-secondary" : ""
            }`}
            disabled={editor_state.playback !== "playing"}
            aria-label="Pause"
            title="Pause"
            onClick={() => void dispatch_transport({ type: "pause" })}
          >
            <PauseIcon />
          </Button>
          <Button
            type="button"
            className={transport_button_class_name}
            disabled={editor_state.playback === "stopped"}
            aria-label="Stop"
            title="Stop"
            onClick={() => void dispatch_transport({ type: "stop" })}
          >
            <StopIcon />
          </Button>
        </div>
      )}
    </main>
  );
};

function publish_renderer_evidence(
  main: HTMLElement,
  renderer: Renderer,
  frame: RenderFrameResult,
): void {
  main.dataset.rendererStatus = renderer.status.type;
  main.dataset.validationErrors = String(renderer.validation_error_count);
  main.dataset.frameTechnique = frame.type;
  if (frame.type === "raster") {
    main.dataset.frameReason = frame.reason;
    main.dataset.accumulatedSamples = "0";
    delete main.dataset.cpuOraclePick;
    if (frame.path_tracing_failure === undefined) {
      delete main.dataset.rendererFailure;
    } else {
      main.dataset.rendererFailure = frame.path_tracing_failure;
    }
    return;
  }
  main.dataset.frameReason = frame.accumulation;
  main.dataset.accumulatedSamples = String(frame.accumulated_samples);
  main.dataset.cpuOraclePick = frame.cpu_oracle.type === "hit"
    ? frame.cpu_oracle.object_id
    : "miss";
  delete main.dataset.rendererFailure;
}

function frame_label(frame: RenderFrameResult): string {
  if (frame.type === "path_traced") {
    return `Path traced · ${frame.accumulated_samples} samples`;
  }
  if (frame.reason === "camera_motion") return "Raster preview · camera moving";
  if (frame.reason === "path_tracing_fallback") {
    return "Raster · path tracing unavailable";
  }
  return "Raster";
}

function semantic_pointer_event(
  event: ReactPointerEvent<InkGameSurfaceElement>,
): boolean {
  return event.nativeEvent.composedPath().some((target) =>
    target instanceof HTMLButtonElement &&
    target.dataset.inkSemanticId !== undefined
  );
}

function editable_keyboard_target(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;
}

function canvas_viewport(canvas: HTMLCanvasElement) {
  return {
    width: Math.max(1, Math.floor(canvas.clientWidth)),
    height: Math.max(1, Math.floor(canvas.clientHeight)),
  };
}

function runtime_observer(sink: ObservationSink): Observer {
  return new Observer({
    source: { subsystem: "development-runtime" },
    sink,
    clock: { now_seconds: () => performance.now() / 1000 },
  });
}

function adventure_audio_observer(sink: ObservationSink): Observer {
  return new Observer({
    source: { subsystem: "adventure-audio" },
    sink,
    clock: { now_seconds: () => performance.now() / 1000 },
  });
}

async function fetch_game_artifact(
  assets: Pick<
    GameDevelopmentProps["assets"],
    "wasm_url" | "manifest_url"
  >,
  scene_assets: SceneAssetStore,
): Promise<AdventureArtifactSource> {
  const [wasm_response, manifest_response, level_asset] = await Promise.all([
    fetch(assets.wasm_url, { cache: "no-store" }),
    fetch(assets.manifest_url, { cache: "no-store" }),
    load_level_asset(scene_assets),
  ]);
  if (!wasm_response.ok) {
    throw new Error(`game Wasm returned ${wasm_response.status}`);
  }
  if (!manifest_response.ok) {
    throw new Error(`game manifest returned ${manifest_response.status}`);
  }
  return {
    wasm_bytes: new Uint8Array(await wasm_response.arrayBuffer()),
    manifest_source: await manifest_response.text(),
    data_assets: [level_asset],
  };
}

async function load_level_asset(
  scene_assets: SceneAssetStore,
): Promise<BlotIntegerDataAsset> {
  const bytes = await scene_assets.read(asset_id("levels/starter.json"));
  return parse_blot_integer_data_asset(
    0,
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
}

function browser_development_artifacts(): {
  load(path: string): Promise<Uint8Array>;
} {
  return {
    async load(path) {
      const response = await fetch(`/${path}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(
          `adventure development artifact ${
            JSON.stringify(path)
          } returned ${response.status}`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

async function fetch_development_revision(wasm_url: string): Promise<unknown> {
  if (!wasm_url.endsWith(".wasm")) {
    throw new Error(
      `adventure Wasm URL ${JSON.stringify(wasm_url)} must end in .wasm`,
    );
  }
  const descriptor_url = `${
    wasm_url.slice(0, -".wasm".length)
  }.development.json`;
  const response = await fetch(descriptor_url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `adventure development revision returned ${response.status}`,
    );
  }
  return await response.json();
}

async function import_development_runtime(): Promise<unknown> {
  const runtime_url = "/@ink/blot-development-runtime.js";
  return await import(/* @vite-ignore */ runtime_url);
}

type AdventureDevelopmentEvidence =
  | { readonly type: "production" | "loading" }
  | { readonly type: "activating" | "failed"; readonly revision: string }
  | {
    readonly type: "ready";
    readonly revision: string;
    readonly entry_retained: boolean;
    readonly state_preserved: boolean;
  };

function publish_development_evidence(
  application: HTMLElement | null,
  evidence: AdventureDevelopmentEvidence,
): void {
  if (application === null) return;
  application.dataset.developmentStatus = evidence.type;
  if (!("revision" in evidence)) {
    delete application.dataset.developmentRevision;
  } else {
    application.dataset.developmentRevision = evidence.revision;
  }
  if (evidence.type !== "ready") {
    delete application.dataset.developmentEntryRetained;
    delete application.dataset.developmentStatePreserved;
    return;
  }
  application.dataset.developmentEntryRetained = String(
    evidence.entry_retained,
  );
  application.dataset.developmentStatePreserved = String(
    evidence.state_preserved,
  );
}

async function load_render_assets(
  resources: readonly SceneResource[],
  assets: SceneAssetStore,
): Promise<AdventureRenderAssets> {
  const loaded = await assets.replace(resources);
  const meshes = loaded.meshes.map(({ id, indices, vertices }) =>
    Object.freeze({ id, indices, vertices })
  );
  const textures = await Promise.all(
    loaded.textures.map(async (texture) => {
      const texture_buffer = new ArrayBuffer(texture.bytes.byteLength);
      new Uint8Array(texture_buffer).set(texture.bytes);
      const render_texture: RenderTexture = Object.freeze({
        id: texture.asset,
        color_space: "srgb",
        source: await createImageBitmap(
          new Blob([texture_buffer], { type: texture.mime_type }),
        ),
      });
      return Object.freeze({
        id: texture.id,
        texture: render_texture,
      });
    }),
  );
  return Object.freeze({ meshes, textures });
}

function required_scene_asset_store(
  store: SceneAssetStore | null,
): SceneAssetStore {
  if (store === null) {
    throw new Error("adventure scene asset store is unavailable");
  }
  return store;
}

function resource_fingerprint(resources: readonly SceneResource[]): string {
  return JSON.stringify(resources);
}

function renderer_notice(reason: string): string {
  const sentence = reason.endsWith(".") ? reason : `${reason}.`;
  return `3D preview unavailable: ${sentence} The game remains playable.`;
}
