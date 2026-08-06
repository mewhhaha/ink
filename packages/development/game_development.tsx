/// <reference types="vite/client" />

import { Button } from "@comp0/react";
import { PauseIcon, PlayIcon, StopIcon } from "@heroicons/react/24/solid";
import type { GameGuest } from "@ink/blot/game_guest.ts";
import {
  close_game,
  describe_game_frame,
  type GameFrame,
  reload_game_frame,
  reset_game_frame,
  resize_game_frame,
  run_game_program,
  step_game_frame,
} from "@ink/blot/game_effects.ts";
import {
  create_headless_session,
  type HeadlessSession,
  type SessionContext,
} from "@ink/blot/headless_session.ts";
import { parse_obj_model } from "@ink/assets/mesh.ts";
import type {
  GameAction,
  GameObservation,
  GameViewport,
  SceneResource,
  SemanticRegion,
} from "@ink/blot/protocol.ts";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  apply_editor_action,
  type EditorAction,
  game_action_enabled,
  initial_editor_state,
} from "./logic.ts";
import type { GameDevelopmentContext } from "./game_development_context.ts";
export type { GameDevelopmentContext } from "./game_development_context.ts";
import {
  create_keyboard_input_controller,
  game_surface_owns_pointer_lock,
  type KeyboardActionBinding,
} from "./input_bindings.ts";
export type {
  ContinuousKeyboardActionBinding,
  KeyboardActionBinding,
} from "./input_bindings.ts";
import { debugger_help, type DebuggerCommand } from "./debugger.ts";
import { DebuggerWindow } from "./debugger_window.tsx";
import type {
  InkGameSurfaceElement,
  SemanticInteraction,
} from "./game_surface.ts";
import "./game_surface.ts";
import { type GameUpdate, subscribe_to_game_updates } from "./hot_reload.ts";
import {
  create_preview_renderer,
  create_semantic_renderer,
  type PreviewMesh,
  type PreviewRenderer,
  type PreviewTexture,
} from "./webgpu.ts";
import "./styles.css";

const transport_button_class_name =
  "inline-flex size-9 items-center justify-center rounded-md outline-none transition-colors data-focus-visible:ring-3 data-focus-visible:ring-ring/50 data-hovered:bg-accent data-pressed:bg-secondary disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4";

export interface GameDevelopmentProps {
  readonly assets: {
    readonly wasm_url: string;
    readonly manifest_url: string;
  };
  readonly load_artifact: (
    wasm_bytes: Uint8Array,
    manifest_source: string,
  ) => Promise<{
    readonly guest: GameGuest;
    readonly context: SessionContext;
  }>;
  readonly keyboard_actions?: Readonly<Record<string, KeyboardActionBinding>>;
  readonly logical_viewport?: GameViewport;
  readonly always_enable_semantic_buttons?: boolean;
  readonly semantic_interaction?: SemanticInteraction;
  readonly show_debugger?: boolean;
  readonly show_metrics?: boolean;
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

export const GameDevelopment = function game_development(
  {
    assets,
    always_enable_semantic_buttons = false,
    keyboard_actions,
    load_artifact,
    logical_viewport,
    pointer_action,
    pointer_lock,
    render_editor,
    semantic_interaction = "activate",
    show_debugger = false,
    show_metrics = true,
  }: GameDevelopmentProps,
) {
  "use memo";

  const [editor_state, set_editor_state] = useState(initial_editor_state);
  const [editor_observation, set_editor_observation] = useState<
    GameObservation
  >();
  const [runtime_message, set_runtime_message] = useState("Loading game");
  const [runtime_notice, set_runtime_notice] = useState<string | null>(null);
  const observation_reference = useRef<GameObservation | undefined>(undefined);
  const main_reference = useRef<HTMLElement>(null);
  const rendered_regions_reference = useRef<readonly SemanticRegion[]>([]);
  const semantic_update_time_reference = useRef(0);
  const surface_reference = useRef<InkGameSurfaceElement>(null);
  const session_reference = useRef<HeadlessSession | null>(null);
  const renderer_reference = useRef<PreviewRenderer | null>(null);
  const artifact_digest_reference = useRef<string | null>(null);
  const resource_fingerprint_reference = useRef<string | null>(null);
  const hot_reload_error_reference = useRef<string | null>(null);
  const load_artifact_reference = useRef(load_artifact);
  const render_editor_reference = useRef(render_editor);
  const semantic_interaction_reference = useRef(semantic_interaction);
  const playback_reference = useRef(editor_state.playback);
  const pending_zoom_reference = useRef<
    Extract<GameAction, { readonly type: "zoom" }> | undefined
  >(undefined);
  const painting_pointer_reference = useRef<number | null>(null);
  const painted_action_reference = useRef<string | null>(null);
  const metrics_output_reference = useRef<HTMLOutputElement>(null);
  const frame_metrics_reference = useRef({
    frames: 0,
    rendered_at: performance.now(),
    sampled_at: performance.now(),
  });
  const wasm_url = assets.wasm_url;
  const manifest_url = assets.manifest_url;

  useEffect(() => {
    load_artifact_reference.current = load_artifact;
    render_editor_reference.current = render_editor;
    semantic_interaction_reference.current = semantic_interaction;
  }, [load_artifact, render_editor, semantic_interaction]);

  useEffect(() => {
    playback_reference.current = editor_state.playback;
    surface_reference.current?.set_gameplay_enabled(
      always_enable_semantic_buttons || editor_state.playback === "playing",
    );
  }, [editor_state.playback]);

  useEffect(() => {
    if (!keyboard_actions) return;
    const input = create_keyboard_input_controller(
      keyboard_actions,
      (action_id) => void dispatch_action_id(action_id),
    );
    const accepts_keyboard_input = () => {
      const main = main_reference.current;
      const surface = surface_reference.current;
      return main?.contains(document.activeElement) === true ||
        game_surface_owns_pointer_lock(surface, document.pointerLockElement);
    };
    const key_down = (event: KeyboardEvent) => {
      if (!accepts_keyboard_input() || editable_keyboard_target(event.target)) {
        return;
      }
      if (input.press(event.key, event.code, event.repeat)) {
        event.preventDefault();
      }
    };
    const key_up = (event: KeyboardEvent) => {
      if (input.release(event.code)) event.preventDefault();
    };
    const release_held_inputs = () => input.release_all();
    const release_after_pointer_unlock = () => {
      if (
        !game_surface_owns_pointer_lock(
          surface_reference.current,
          document.pointerLockElement,
        )
      ) {
        release_held_inputs();
      }
    };

    globalThis.addEventListener("keydown", key_down);
    globalThis.addEventListener("keyup", key_up);
    globalThis.addEventListener("blur", release_held_inputs);
    document.addEventListener(
      "pointerlockchange",
      release_after_pointer_unlock,
    );
    return () => {
      globalThis.removeEventListener("keydown", key_down);
      globalThis.removeEventListener("keyup", key_up);
      globalThis.removeEventListener("blur", release_held_inputs);
      document.removeEventListener(
        "pointerlockchange",
        release_after_pointer_unlock,
      );
      release_held_inputs();
    };
  }, [keyboard_actions]);

  useEffect(() => {
    const surface = surface_reference.current;
    if (!surface) return;
    const canvas = surface.canvas;
    let active = true;
    let release_renderer = () => {};

    const start_game = async () => {
      const source = await fetch_game_artifact({ wasm_url, manifest_url });
      const artifact = await load_artifact_reference.current(
        source.wasm_bytes,
        source.manifest_source,
      );
      const session = await create_headless_session(
        artifact.guest,
        artifact.context,
        logical_viewport ?? canvas_viewport(canvas),
      );
      const frame = await run_game_program(describe_game_frame(), session);
      let renderer: PreviewRenderer;
      try {
        const preview_assets = await load_preview_assets(
          frame.snapshot.resources,
        );
        renderer = await create_preview_renderer(
          canvas,
          preview_assets.meshes,
          preview_assets.textures,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(
          "3D assets unavailable; semantic game remains active",
          error,
        );
        renderer = create_semantic_renderer(
          `3D assets failed to load: ${reason}`,
        );
      }
      artifact_digest_reference.current = artifact.context.artifact_digest;
      resource_fingerprint_reference.current = resource_fingerprint(
        frame.snapshot.resources,
      );
      if (!active) {
        await run_game_program(close_game(), session);
        renderer.dispose();
        return;
      }
      session_reference.current = session;
      renderer_reference.current = renderer;
      surface.dataset.gpuAdapter = renderer.adapter_description ??
        "unavailable";
      release_renderer = renderer.on_unavailable((reason) => {
        if (active) set_runtime_notice(renderer_notice(reason));
      });
      await apply_frame(frame, renderer);
      if (renderer.unavailable_reason) {
        set_runtime_notice(renderer_notice(renderer.unavailable_reason));
      }
    };

    void start_game().catch(
      (error) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        set_runtime_message(message);
        set_runtime_notice(`Game failed to start: ${message}`);
      },
    );

    return () => {
      active = false;
      release_renderer();
      renderer_reference.current?.dispose();
      const session = session_reference.current;
      if (session) void run_game_program(close_game(), session);
    };
  }, [manifest_url, wasm_url]);

  useEffect(() => {
    let active = true;
    let reload_queue = Promise.resolve();
    const reload_game = async (update: GameUpdate) => {
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
        return;
      }
      const session = session_reference.current;
      if (!session) return;
      try {
        if (update.type === "resources") {
          const frame = await run_game_program(describe_game_frame(), session);
          const renderer = renderer_reference.current;
          if (renderer) {
            await apply_frame(frame, renderer, { reload_resources: true });
          }
          hot_reload_error_reference.current = null;
          if (!renderer?.unavailable_reason) set_runtime_notice(null);
          set_runtime_message(
            `Resources reloaded. ${frame.observation.status.value}`,
          );
          return;
        }
        const source = await fetch_game_artifact({ wasm_url, manifest_url });
        const artifact = await load_artifact_reference.current(
          source.wasm_bytes,
          source.manifest_source,
        );
        if (!active) return;
        if (
          artifact.context.artifact_digest === artifact_digest_reference.current
        ) {
          hot_reload_error_reference.current = null;
          if (!renderer_reference.current?.unavailable_reason) {
            set_runtime_notice(null);
          }
          set_runtime_message("Game compilation recovered");
          return;
        }

        const reloaded = await run_game_program(
          reload_game_frame(artifact.guest, artifact.context),
          session,
        );
        artifact_digest_reference.current = artifact.context.artifact_digest;
        const renderer = renderer_reference.current;
        if (renderer) {
          await apply_frame(
            { observation: reloaded.observation, snapshot: reloaded.snapshot },
            renderer,
          );
        }
        hot_reload_error_reference.current = null;
        if (!renderer?.unavailable_reason) set_runtime_notice(null);
        set_runtime_message(
          reloaded.preserved
            ? `Game reloaded; state preserved. ${reloaded.observation.status.value}`
            : `Game reloaded with an incompatible schema; state reset. ${reloaded.observation.status.value}`,
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
        }
      }
    };

    const hot = import.meta.hot;
    if (!hot) return;
    const unsubscribe = subscribe_to_game_updates(
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
      const session = session_reference.current;
      const renderer = renderer_reference.current;
      if (!stepping && session && renderer) {
        const delta_us = pending_delta_us;
        pending_delta_us = 0;
        const action = pending_zoom_reference.current ?? { type: "frame" };
        pending_zoom_reference.current = undefined;
        stepping = true;
        void run_game_program(
          step_game_frame(action, delta_us),
          session,
        ).then((frame) =>
          apply_frame(frame, renderer, { sample_semantics: true })
        ).catch(
          report_runtime_error,
        ).finally(() => {
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
      const session = session_reference.current;
      if (!session) return;
      try {
        const frame = await run_game_program(
          resize_game_frame(viewport),
          session,
        );
        const renderer = renderer_reference.current;
        if (renderer) await apply_frame(frame, renderer);
      } catch (error) {
        report_runtime_error(error);
      }
    };
    const observer = new ResizeObserver(resize_canvas);
    observer.observe(canvas);
    void resize_canvas();
    return () => observer.disconnect();
  }, []);

  const dispatch_transport = async (action: EditorAction) => {
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
    if (action.type !== "play") pending_zoom_reference.current = undefined;
    if (action.type !== "stop") return;
    const session = session_reference.current;
    if (!session) return;
    try {
      const frame = await run_game_program(reset_game_frame(), session);
      const renderer = renderer_reference.current;
      if (renderer) await apply_frame(frame, renderer);
    } catch (error) {
      report_runtime_error(error);
    }
  };

  const dispatch_session_action = async (action: GameAction) => {
    const session = session_reference.current;
    if (!session) return;
    try {
      const frame = await run_game_program(step_game_frame(action), session);
      const renderer = renderer_reference.current;
      if (renderer) await apply_frame(frame, renderer);
    } catch (error) {
      report_runtime_error(error);
    }
  };

  const dispatch_game_action = async (action: GameAction) => {
    if (!game_action_enabled(playback_reference.current, action)) return;
    if (action.type === "zoom" && playback_reference.current === "playing") {
      pending_zoom_reference.current = action;
      return;
    }
    await dispatch_session_action(action);
  };

  const dispatch_preview_update:
    GameDevelopmentContext["dispatch_preview_update"] = dispatch_session_action;

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

  const execute_debugger_command = async (
    command: DebuggerCommand,
  ): Promise<string> => {
    switch (command.type) {
      case "help":
        return debugger_help;
      case "status":
        return JSON.stringify(
          observation_reference.current?.status ?? { status: "loading" },
        );
      case "transport":
        await dispatch_transport(command.action);
        return `transport ${command.action.type}`;
      case "game_action":
        await dispatch_game_action(command.action);
        return JSON.stringify(
          observation_reference.current?.status ?? { status: "loading" },
        );
      case "clear":
        return "history cleared";
    }
  };

  const apply_frame = async (
    frame: GameFrame,
    renderer: PreviewRenderer,
    options: {
      readonly reload_resources?: true;
      readonly sample_semantics?: true;
    } = {},
  ) => {
    const next_fingerprint = resource_fingerprint(frame.snapshot.resources);
    if (
      options.reload_resources ||
      next_fingerprint !== resource_fingerprint_reference.current
    ) {
      const preview_assets = await load_preview_assets(
        frame.snapshot.resources,
      );
      if (renderer !== renderer_reference.current) return;
      renderer.replace_assets(
        preview_assets.meshes,
        preview_assets.textures,
      );
      resource_fingerprint_reference.current = next_fingerprint;
    }
    observation_reference.current = frame.observation;
    const current_time = performance.now();
    const update_semantics = !options.sample_semantics ||
      current_time - semantic_update_time_reference.current >= 250;
    if (update_semantics) {
      rendered_regions_reference.current = frame.observation.regions;
      semantic_update_time_reference.current = current_time;
      surface_reference.current?.update_semantics(
        frame.observation.regions,
        dispatch_game_action,
        semantic_interaction_reference.current,
      );
      if (render_editor_reference.current) {
        set_editor_observation(frame.observation);
      }
    }
    renderer.render(frame.snapshot, rendered_regions_reference.current);
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
    if (
      !renderer.unavailable_reason &&
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

  return (
    <main
      ref={main_reference}
      className="relative h-svh w-screen overflow-hidden bg-black"
      tabIndex={0}
      autoFocus
    >
      <section className="absolute inset-0" aria-label="Game preview">
        <ink-game-surface
          ref={surface_reference}
          className="block size-full"
          onPointerDown={(event) => {
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

      {show_debugger && (
        <DebuggerWindow
          execute_command={execute_debugger_command}
          runtime_message={runtime_message}
        />
      )}

      {render_editor?.({
        observation: editor_observation,
        playback: editor_state.playback,
        can_interact: editor_state.playback === "playing",
        dispatch_game_action,
        dispatch_preview_update,
        dispatch_transport,
      })}

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
    </main>
  );
};

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

async function fetch_game_artifact(
  assets: GameDevelopmentProps["assets"],
): Promise<{
  readonly wasm_bytes: Uint8Array;
  readonly manifest_source: string;
}> {
  const [wasm_response, manifest_response] = await Promise.all([
    fetch(assets.wasm_url, { cache: "no-store" }),
    fetch(assets.manifest_url, { cache: "no-store" }),
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
  };
}

async function load_preview_assets(
  resources: readonly SceneResource[],
): Promise<{
  readonly meshes: readonly PreviewMesh[];
  readonly textures: readonly PreviewTexture[];
}> {
  const meshes = resources.filter((resource) => resource.type === "mesh");
  const textures = resources.filter((resource) => resource.type === "texture");
  const [models, images] = await Promise.all([
    Promise.all(meshes.map(async (mesh) => {
      const response = await fetch(mesh.url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(
          `scene mesh ${mesh.id} at ${
            JSON.stringify(mesh.url)
          } returned ${response.status}`,
        );
      }
      return { id: mesh.id, model: parse_obj_model(await response.text()) };
    })),
    Promise.all(textures.map(async (texture) => {
      const response = await fetch(texture.url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(
          `scene texture ${texture.id} at ${
            JSON.stringify(texture.url)
          } returned ${response.status}`,
        );
      }
      const source_url = URL.createObjectURL(await response.blob());
      try {
        const source = new Image();
        source.src = source_url;
        await source.decode();
        const image = document.createElement("canvas");
        image.width = source.naturalWidth;
        image.height = source.naturalHeight;
        const context = image.getContext("2d");
        if (!context) {
          throw new Error(
            `scene texture ${texture.id} could not create a 2D canvas`,
          );
        }
        context.drawImage(source, 0, 0);
        const pixels = context.getImageData(0, 0, image.width, image.height);
        return {
          id: texture.id,
          width: image.width,
          height: image.height,
          pixels: new Uint8Array(pixels.data),
        };
      } finally {
        URL.revokeObjectURL(source_url);
      }
    })),
  ]);
  return { meshes: models, textures: images };
}

function resource_fingerprint(resources: readonly SceneResource[]): string {
  return JSON.stringify(resources);
}

function renderer_notice(reason: string): string {
  const sentence = reason.endsWith(".") ? reason : `${reason}.`;
  return `3D preview unavailable: ${sentence} The game remains playable.`;
}
