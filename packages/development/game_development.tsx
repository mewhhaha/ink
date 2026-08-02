/// <reference types="vite/client" />

import { Button } from "@comp0/react";
import { PauseIcon, PlayIcon, StopIcon } from "@heroicons/react/24/solid";
import type { GameGuest } from "@ink/engine/guest.ts";
import {
  close_game,
  describe_game_frame,
  type GameFrame,
  reload_game_frame,
  reset_game_frame,
  resize_game_frame,
  run_game_program,
  step_game_frame,
} from "@ink/engine/game_effects.ts";
import {
  create_headless_session,
  type HeadlessSession,
  type SessionContext,
} from "@ink/engine/headless_session.ts";
import { parse_obj_model } from "@ink/engine/model.ts";
import type {
  GameAction,
  GameObservation,
  SemanticRegion,
} from "@ink/engine/protocol.ts";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  apply_editor_action,
  type EditorAction,
  initial_editor_state,
} from "./logic.ts";
import { subscribe_to_game_updates } from "./hot_reload.ts";
import {
  create_preview_renderer,
  create_semantic_renderer,
  type PreviewRenderer,
} from "./webgpu.ts";
import "./styles.css";

const transport_button_class_name =
  "inline-flex size-9 items-center justify-center rounded-md outline-none transition-colors data-focus-visible:ring-3 data-focus-visible:ring-ring/50 data-hovered:bg-accent data-pressed:bg-secondary disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4";

export interface GameDevelopmentProps {
  readonly assets: {
    readonly wasm_url: string;
    readonly manifest_url: string;
    readonly meshes: readonly {
      readonly id: number;
      readonly url: string;
    }[];
  };
  readonly load_artifact: (
    wasm_bytes: Uint8Array,
    manifest_source: string,
  ) => Promise<{
    readonly guest: GameGuest;
    readonly context: SessionContext;
  }>;
  readonly keyboard_actions?: Readonly<Record<string, string>>;
  readonly semantic_interaction?: "activate" | "paint";
  readonly render_editor?: (context: GameDevelopmentContext) => ReactNode;
}

export interface GameDevelopmentContext {
  readonly observation: GameObservation | undefined;
  readonly dispatch_game_action: (action: GameAction) => Promise<void>;
}

export const GameDevelopment = function game_development(
  {
    assets,
    keyboard_actions,
    load_artifact,
    render_editor,
    semantic_interaction = "activate",
  }: GameDevelopmentProps,
) {
  "use memo";

  const [editor_state, set_editor_state] = useState(initial_editor_state);
  const [observation, set_observation] = useState<GameObservation>();
  const [runtime_message, set_runtime_message] = useState("Loading game");
  const [runtime_notice, set_runtime_notice] = useState<string | null>(null);
  const canvas_reference = useRef<HTMLCanvasElement>(null);
  const painting_pointer_reference = useRef<number | null>(null);
  const session_reference = useRef<HeadlessSession | null>(null);
  const renderer_reference = useRef<PreviewRenderer | null>(null);
  const artifact_digest_reference = useRef<string | null>(null);

  useEffect(() => {
    const finish_painting = () => {
      painting_pointer_reference.current = null;
    };
    globalThis.addEventListener("pointerup", finish_painting);
    globalThis.addEventListener("pointercancel", finish_painting);
    return () => {
      globalThis.removeEventListener("pointerup", finish_painting);
      globalThis.removeEventListener("pointercancel", finish_painting);
    };
  }, []);

  useEffect(() => {
    const canvas = canvas_reference.current;
    if (!canvas) return;
    let active = true;
    let release_renderer = () => {};

    Promise.all([
      fetch_game_artifact(assets),
      load_preview_renderer(canvas, assets.meshes),
    ]).then(
      async ([source, renderer]) => {
        const artifact = await load_artifact(
          source.wasm_bytes,
          source.manifest_source,
        );
        const session = await create_headless_session(
          artifact.guest,
          artifact.context,
          canvas_viewport(canvas),
        );
        artifact_digest_reference.current = artifact.context.artifact_digest;
        if (!active) {
          await run_game_program(close_game(), session);
          renderer.dispose();
          return;
        }
        session_reference.current = session;
        renderer_reference.current = renderer;
        release_renderer = renderer.on_unavailable((reason) => {
          if (active) set_runtime_notice(renderer_notice(reason));
        });
        const frame = await run_game_program(describe_game_frame(), session);
        apply_frame(frame, renderer);
        if (renderer.unavailable_reason) {
          set_runtime_notice(renderer_notice(renderer.unavailable_reason));
        }
      },
    ).catch((error) => {
      if (!active) return;
      const message = error instanceof Error ? error.message : String(error);
      set_runtime_message(message);
      set_runtime_notice(`Game failed to start: ${message}`);
    });

    return () => {
      active = false;
      release_renderer();
      renderer_reference.current?.dispose();
      const session = session_reference.current;
      if (session) void run_game_program(close_game(), session);
    };
  }, [assets, load_artifact]);

  useEffect(() => {
    let active = true;
    let reloading = false;
    const reload_game = async () => {
      const session = session_reference.current;
      if (reloading || !session) return;
      reloading = true;
      try {
        const source = await fetch_game_artifact(assets);
        const artifact = await load_artifact(
          source.wasm_bytes,
          source.manifest_source,
        );
        if (
          !active ||
          artifact.context.artifact_digest === artifact_digest_reference.current
        ) return;

        const reloaded = await run_game_program(
          reload_game_frame(artifact.guest, artifact.context),
          session,
        );
        artifact_digest_reference.current = artifact.context.artifact_digest;
        const renderer = renderer_reference.current;
        if (renderer) {
          apply_frame(
            { observation: reloaded.observation, snapshot: reloaded.snapshot },
            renderer,
          );
        }
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
          set_runtime_message(`Game reload failed: ${message}`);
          set_runtime_notice(`Game reload failed: ${message}`);
        }
      } finally {
        reloading = false;
      }
    };

    const hot = import.meta.hot;
    if (!hot) return;
    const unsubscribe = subscribe_to_game_updates(
      hot,
      () => void reload_game(),
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, [assets, load_artifact]);

  useEffect(() => {
    if (editor_state.playback !== "playing") return;

    let previous_time = performance.now();
    let animation_frame = requestAnimationFrame(advance);
    function advance(current_time: number) {
      const delta_seconds = (current_time - previous_time) / 1000;
      previous_time = current_time;
      set_editor_state((current) =>
        apply_editor_action(current, {
          type: "advance",
          deltaSeconds: delta_seconds,
        })
      );
      const session = session_reference.current;
      const renderer = renderer_reference.current;
      if (session && renderer) {
        void run_game_program(
          step_game_frame(
            { type: "frame" },
            Math.max(0, Math.round(delta_seconds * 1_000_000)),
          ),
          session,
        ).then((frame) => {
          apply_frame(frame, renderer);
        }).catch(report_runtime_error);
      }
      animation_frame = requestAnimationFrame(advance);
    }
    return () => cancelAnimationFrame(animation_frame);
  }, [editor_state.playback]);

  useEffect(() => {
    const canvas = canvas_reference.current;
    if (!canvas) return;
    const resize_canvas = async () => {
      const pixel_ratio = globalThis.devicePixelRatio || 1;
      const viewport = canvas_viewport(canvas);
      canvas.width = Math.max(1, Math.floor(viewport.width * pixel_ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * pixel_ratio));
      const session = session_reference.current;
      if (!session) return;
      try {
        const frame = await run_game_program(
          resize_game_frame(viewport),
          session,
        );
        const renderer = renderer_reference.current;
        if (renderer) apply_frame(frame, renderer);
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
    set_editor_state((current) => apply_editor_action(current, action));
    if (action.type !== "stop") return;
    const session = session_reference.current;
    if (!session) return;
    try {
      const frame = await run_game_program(reset_game_frame(), session);
      const renderer = renderer_reference.current;
      if (renderer) apply_frame(frame, renderer);
    } catch (error) {
      report_runtime_error(error);
    }
  };

  const dispatch_game_action = async (action: GameAction) => {
    const session = session_reference.current;
    if (!session) return;
    try {
      const frame = await run_game_program(step_game_frame(action), session);
      const renderer = renderer_reference.current;
      if (renderer) apply_frame(frame, renderer);
    } catch (error) {
      report_runtime_error(error);
    }
  };

  const apply_frame = (frame: GameFrame, renderer: PreviewRenderer) => {
    set_observation(frame.observation);
    renderer.render(frame.snapshot, frame.observation.regions);
    set_runtime_message(frame.observation.status.value);
    if (!renderer.unavailable_reason) set_runtime_notice(null);
  };

  const report_runtime_error = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    set_runtime_message(message);
    set_runtime_notice(`Game runtime failed: ${message}`);
  };

  return (
    <main
      className="relative h-svh w-screen overflow-hidden bg-black"
      onKeyDown={(event) => {
        const action_id = keyboard_actions?.[event.key.toLowerCase()];
        if (!action_id) return;
        const action = observation?.actions.find((candidate) =>
          candidate.id === action_id
        )?.action;
        if (action) void dispatch_game_action(action);
      }}
    >
      <section className="absolute inset-0" aria-label="Game preview">
        <canvas
          ref={canvas_reference}
          className="block size-full"
          {...{ layoutsubtree: "" }}
        >
          {observation?.regions.map((region) => {
            const element_properties = {
              className: "canvas-semantic-region",
              style: semantic_region_style(region),
              "aria-label": region.label,
              "aria-description": region.description,
              "data-ink-semantic-id": region.id,
            } as const;
            switch (region.role) {
              case "button":
                return (
                  <button
                    key={region.id}
                    {...element_properties}
                    type="button"
                    aria-pressed={region.pressed}
                    data-selected={region.selected || undefined}
                    onFocus={() =>
                      void dispatch_game_action({
                        type: "focus",
                        target: region.target,
                      })}
                    onPointerDown={(event) => {
                      if (semantic_interaction !== "paint") return;
                      if (event.button !== 0) return;
                      event.preventDefault();
                      painting_pointer_reference.current = event.pointerId;
                      event.currentTarget.focus();
                      void dispatch_game_action({
                        type: "activate",
                        target: region.target,
                      });
                    }}
                    onPointerEnter={(event) => {
                      if (semantic_interaction !== "paint") return;
                      if (
                        painting_pointer_reference.current !== event.pointerId
                      ) return;
                      if ((event.buttons & 1) === 0) return;
                      event.currentTarget.focus();
                      void dispatch_game_action({
                        type: "activate",
                        target: region.target,
                      });
                    }}
                    onClick={(event) => {
                      if (
                        semantic_interaction === "paint" && event.detail !== 0
                      ) return;
                      void dispatch_game_action({
                        type: "activate",
                        target: region.target,
                      });
                    }}
                  >
                    {region.label}
                  </button>
                );
              case "text":
                return (
                  <span key={region.id} {...element_properties}>
                    {region.label}
                  </span>
                );
              case "progress":
                return (
                  <progress
                    key={region.id}
                    {...element_properties}
                    max={region.maximum}
                    value={region.value}
                  />
                );
            }
          })}
        </canvas>
        <output className="sr-only" aria-live="polite">
          {runtime_message}
        </output>
        {runtime_notice && (
          <output className="runtime-notice" aria-live="polite">
            {runtime_notice}
          </output>
        )}
      </section>

      {render_editor?.({ observation, dispatch_game_action })}

      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-1 rounded-lg border border-border bg-background/90 p-1 shadow-lg backdrop-blur-sm">
        <Button
          type="button"
          className={`${transport_button_class_name} ${
            editor_state.playback === "playing" ? "bg-secondary" : ""
          }`}
          disabled={editor_state.playback === "playing"}
          aria-label="Play"
          title="Play"
          onClick={() => void dispatch_transport({ type: "play" })}
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

function canvas_viewport(canvas: HTMLCanvasElement) {
  return {
    width: Math.max(1, Math.floor(canvas.clientWidth)),
    height: Math.max(1, Math.floor(canvas.clientHeight)),
  };
}

function semantic_region_style(region: SemanticRegion): CSSProperties {
  return {
    backgroundColor: region.style.background_color,
    borderColor: region.style.border_color,
    borderRadius: region.style.border_radius,
    borderStyle: "solid",
    borderWidth: region.style.border_width,
    color: region.style.color,
    fontSize: region.style.font_size,
    fontWeight: region.style.font_weight,
    width: region.element_size.width,
    height: region.element_size.height,
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

async function load_preview_renderer(
  canvas: HTMLCanvasElement,
  meshes: GameDevelopmentProps["assets"]["meshes"],
): Promise<PreviewRenderer> {
  try {
    const models = await Promise.all(meshes.map(async (mesh) => {
      const response = await fetch(mesh.url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(
          `scene mesh ${mesh.id} at ${
            JSON.stringify(mesh.url)
          } returned ${response.status}`,
        );
      }
      return { id: mesh.id, model: parse_obj_model(await response.text()) };
    }));
    return await create_preview_renderer(
      canvas,
      models,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("3D meshes unavailable; semantic game remains active", error);
    return create_semantic_renderer(`3D meshes failed to load: ${reason}`);
  }
}

function renderer_notice(reason: string): string {
  const sentence = reason.endsWith(".") ? reason : `${reason}.`;
  return `3D preview unavailable: ${sentence} The game remains playable.`;
}
