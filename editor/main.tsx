import { Button } from "@comp0/react";
import { PauseIcon, PlayIcon, StopIcon } from "@heroicons/react/24/solid";
import { createElement, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  close_game,
  observe_game_frame,
  type ObservedFrame,
  reload_game_frame,
  render_game,
  reset_game_frame,
  resize_game_frame,
  run_game_program,
  step_game_frame,
} from "../runtime/game_effects.ts";
import {
  create_headless_session,
  type HeadlessSession,
} from "../runtime/headless_session.ts";
import { load_scene_explorer_artifact } from "../runtime/load_scene_explorer.ts";
import { parse_obj_model } from "../runtime/model.ts";
import type { GameAction, GameObservation } from "../runtime/protocol.ts";
import {
  apply_editor_action,
  type EditorAction,
  type EditorState,
  initialEditorState,
} from "./logic.ts";
import {
  create_preview_renderer,
  create_semantic_renderer,
  type PreviewRenderer,
} from "./webgpu.ts";
import "./styles.css";

const transport_button_class_name =
  "inline-flex size-9 items-center justify-center rounded-md outline-none transition-colors data-focus-visible:ring-3 data-focus-visible:ring-ring/50 data-hovered:bg-accent data-pressed:bg-secondary disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4";

function editor_app() {
  "use memo";

  const [editor_state, set_editor_state] = useState(initialEditorState);
  const [observation, set_observation] = useState<GameObservation>();
  const [runtime_message, set_runtime_message] = useState("Loading game");
  const [runtime_notice, set_runtime_notice] = useState<string | null>(null);
  const canvas_reference = useRef<HTMLCanvasElement>(null);
  const editor_state_reference = useRef<EditorState>(initialEditorState);
  const session_reference = useRef<HeadlessSession | null>(null);
  const renderer_reference = useRef<PreviewRenderer | null>(null);
  const artifact_digest_reference = useRef<string | null>(null);

  useEffect(() => {
    editor_state_reference.current = editor_state;
  }, [editor_state]);

  useEffect(() => {
    const canvas = canvas_reference.current;
    if (!canvas) return;
    let active = true;
    let release_renderer = () => {};

    Promise.all([fetch_scene_source(), load_preview_renderer(canvas)]).then(
      async ([source, renderer]) => {
        const artifact = await load_scene_explorer_artifact(
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
        const frame = await run_game_program(observe_game_frame(), session);
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
  }, []);

  useEffect(() => {
    let active = true;
    let reloading = false;
    const interval = setInterval(async () => {
      const session = session_reference.current;
      if (reloading || !session) return;
      reloading = true;
      try {
        const source = await fetch_scene_source();
        const artifact = await load_scene_explorer_artifact(
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
    }, 1_000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

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
        void run_game_program(render_game(), session).then((snapshot) => {
          renderer.render(snapshot);
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

  const apply_frame = (frame: ObservedFrame, renderer: PreviewRenderer) => {
    set_observation(frame.observation);
    renderer.render(frame.snapshot);
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
        if (event.key.toLowerCase() === "p") {
          void dispatch_game_action({
            type: "toggle_projection",
          });
        }
      }}
    >
      <section className="absolute inset-0" aria-label="Scene explorer game">
        <canvas
          ref={canvas_reference}
          className="block size-full"
          aria-hidden="true"
        />
        {observation?.regions.map((region) => (
          <button
            key={region.id}
            type="button"
            className="semantic-region"
            style={{
              left: region.bounds.left,
              top: region.bounds.top,
              width: region.bounds.width,
              height: region.bounds.height,
            }}
            aria-label={region.label}
            aria-description={region.description}
            aria-pressed={region.pressed}
            data-selected={region.selected || undefined}
            onFocus={() =>
              void dispatch_game_action({
                type: "focus",
                target: region.order,
              })}
            onClick={() =>
              void dispatch_game_action({
                type: "activate",
                target: region.order,
              })}
          >
            {region.label}
          </button>
        ))}
        <output className="sr-only" aria-live="polite">
          {runtime_message}
        </output>
        {runtime_notice && (
          <output className="runtime-notice" aria-live="polite">
            {runtime_notice}
          </output>
        )}
      </section>

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
}

function canvas_viewport(canvas: HTMLCanvasElement) {
  return {
    width: Math.max(1, Math.floor(canvas.clientWidth)),
    height: Math.max(1, Math.floor(canvas.clientHeight)),
  };
}

async function fetch_scene_source(): Promise<{
  readonly wasm_bytes: Uint8Array;
  readonly manifest_source: string;
}> {
  const [wasm_response, manifest_response] = await Promise.all([
    fetch("/scene_explorer.wasm", { cache: "no-store" }),
    fetch("/scene_explorer.wasm.json", { cache: "no-store" }),
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
): Promise<PreviewRenderer> {
  try {
    const response = await fetch("/beacon.obj", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`beacon model returned ${response.status}`);
    }
    return await create_preview_renderer(
      canvas,
      parse_obj_model(await response.text()),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("3D model unavailable; semantic game remains active", error);
    return create_semantic_renderer(`3D model failed to load: ${reason}`);
  }
}

function renderer_notice(reason: string): string {
  const sentence = reason.endsWith(".") ? reason : `${reason}.`;
  return `3D preview unavailable: ${sentence} The game remains playable.`;
}

const root = document.getElementById("root");
if (!root) throw new Error("editor root element is missing");
createRoot(root).render(createElement(editor_app));
