/// <reference types="vite/client" />

import { has_authoring_errors } from "@ink/authoring/diagnostics.ts";
import type { GameAction, GameViewport } from "@ink/blot/protocol.ts";
import {
  blot_runtime_codec,
  type BlotPresentation,
} from "@ink/blot/runtime.ts";
import { DevelopmentController } from "@ink/development/controller.ts";
import {
  create_debugger_observation_log,
  DebuggerCommandRegistry,
  type DebuggerEntry,
  maximum_debugger_history_entries,
} from "@ink/development/debugger.ts";
import { DebuggerWindow } from "@ink/development/debugger_window.tsx";
import { narrative_editor } from "@ink/narrative-editor/catalog.ts";
import { apply_narrative_command } from "@ink/narrative-editor/commands.ts";
import {
  narrative_beat_id,
  narrative_scene_id,
} from "@ink/narrative-editor/identity.ts";
import type { NarrativeProject } from "@ink/narrative-editor/model.ts";
import {
  parse_narrative_project,
  serialize_narrative_project,
} from "@ink/narrative-editor/serialization.ts";
import { validate_narrative_project } from "@ink/narrative-editor/validation.ts";
import { NarrativeWorkspace } from "@ink/narrative-editor/workspace.tsx";
import { Observer } from "@ink/observability/observer.ts";
import type { ObservationSink } from "@ink/observability/sink.ts";
import { microseconds } from "@ink/runtime/session.ts";
import { subscribe_to_application_updates } from "@ink/vite/client.ts";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  create_browser_narrative_audio,
  type NarrativeAudio,
} from "./audio.ts";
import { signal_warning_beat } from "./contract.ts";
import { narrative_project_save_url } from "./editor/project_route.ts";
import {
  narrative_presentation,
  next_narrative_timeline_step,
} from "./presentation.ts";
import { NarrativeUi } from "./narrative_ui.tsx";
import {
  create_narrative_guest,
  NarrativeDevelopmentController,
} from "./runtime.ts";
import { VisualNovelStage } from "./stage.tsx";
import "@ink/editor-ui/styles.css";
import "./styles.css";

const artifact_name = "narrative_development";
const viewport: GameViewport = { width: 960, height: 540 };

interface NarrativeArtifactSource {
  readonly wasm_bytes: Uint8Array;
  readonly manifest_source: string;
}

interface NarrativeController {
  readonly snapshot: () => ReturnType<
    DevelopmentController<
      GameAction,
      GameViewport,
      BlotPresentation,
      NarrativeArtifactSource
    >["snapshot"]
  >;
  readonly observation: () => BlotPresentation | undefined;
  subscribe(subscriber: () => void): () => void;
  initialize(): Promise<BlotPresentation | undefined>;
  advance(step: {
    readonly elapsed_us: ReturnType<typeof microseconds>;
    readonly inputs: readonly GameAction[];
  }): Promise<{ readonly snapshot_checksum: string }>;
  reload(): Promise<{ readonly preserved: boolean }>;
  close(): Promise<void>;
}

type NarrativeDevelopmentEvidence =
  | { readonly type: "production" | "loading" }
  | { readonly type: "activating" | "failed"; readonly revision: string }
  | {
    readonly type: "ready";
    readonly revision: string;
    readonly entry_retained: boolean;
    readonly state_preserved: boolean;
  };

export function mount_application(element: HTMLElement): void {
  createRoot(element).render(<NarrativeDevelopment />);
}

export function NarrativeDevelopment() {
  const controller_reference = useRef<NarrativeController | null>(null);
  const continue_timeline_reference = useRef<
    (presentation: BlotPresentation) => void
  >(() => {});
  const [audio] = useState<NarrativeAudio>(create_browser_narrative_audio);
  const [debugger_commands] = useState(() => new DebuggerCommandRegistry());
  const [debugger_open, set_debugger_open] = useState(false);
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
  const [presentation, set_presentation] = useState<BlotPresentation>();
  const [project, set_project] = useState<NarrativeProject>();
  const [selected_scene, set_selected_scene] = useState("station");
  const [runtime_state, set_runtime_state] = useState("loading");
  const [runtime_notice, set_runtime_notice] = useState<string>();
  const [checksum, set_checksum] = useState<string>();
  const [audio_state, set_audio_state] = useState("idle");
  const [audio_events, set_audio_events] = useState(0);
  const [development_evidence, set_development_evidence] = useState<
    NarrativeDevelopmentEvidence
  >(
    import.meta.hot === undefined ? { type: "production" } : {
      type: "loading",
    },
  );

  useEffect(() => {
    let active = true;
    let release_controller = () => {};
    let release_updates = () => {};
    let timeline_generation = 0;
    let timeline_timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const observer = runtime_observer(runtime_observation_log);
    const development_controller = import.meta.hot === undefined
      ? undefined
      : new NarrativeDevelopmentController({
        artifacts: browser_development_artifacts(),
        initial_query: viewport,
        load_revision: fetch_development_revision,
        load_runtime_module: import_development_runtime,
        observer,
      });
    const controller: NarrativeController = development_controller ??
      new DevelopmentController({
        load_source: fetch_artifact,
        create_guest: (source) =>
          create_narrative_guest(source.wasm_bytes, source.manifest_source),
        codec: blot_runtime_codec,
        observer,
        initial_query: viewport,
      });
    controller_reference.current = controller;

    const stop_timeline = () => {
      timeline_generation += 1;
      if (timeline_timer !== undefined) {
        globalThis.clearTimeout(timeline_timer);
        timeline_timer = undefined;
      }
    };
    const continue_timeline = (current: BlotPresentation) => {
      stop_timeline();
      const elapsed_us = next_narrative_timeline_step(current);
      if (elapsed_us === undefined) return;
      const generation = timeline_generation;
      timeline_timer = globalThis.setTimeout(() => {
        timeline_timer = undefined;
        void controller.advance({ elapsed_us, inputs: [] }).then(() => {
          if (!active || generation !== timeline_generation) return;
          const next = controller.observation();
          if (next === undefined) {
            throw new Error(
              "narrative timeline did not publish its next beat",
            );
          }
          set_presentation(next);
          continue_timeline(next);
        }).catch((error) => {
          if (active) set_runtime_notice(error_message(error));
        });
      }, Number(elapsed_us) / 1_000);
    };
    continue_timeline_reference.current = continue_timeline;

    release_controller = controller.subscribe(() => {
      const state = controller.snapshot();
      if (!active) return;
      set_runtime_state(state.type);
      if (state.type === "ready" && state.observation !== undefined) {
        set_presentation(state.observation);
      }
      if (state.type === "failed" || state.type === "failed_with_last_good") {
        set_runtime_notice(state.reason);
      }
    });

    void Promise.all([controller.initialize(), load_project()]).then(
      ([initial, loaded_project]) => {
        if (!active) return;
        if (initial === undefined) {
          throw new Error("narrative runtime did not publish its first frame");
        }
        set_presentation(initial);
        set_project(loaded_project);
        set_selected_scene(loaded_project.initial_scene_id);
        if (development_controller !== undefined) {
          set_development_evidence({
            type: "ready",
            revision: development_controller.active_revision(),
            entry_retained: false,
            state_preserved: false,
          });
        }
        continue_timeline(initial);
      },
    ).catch((error) => {
      if (!active) return;
      set_runtime_state("failed");
      set_runtime_notice(error_message(error));
    });

    const hot = import.meta.hot;
    if (hot) {
      let reload_queue = Promise.resolve();
      release_updates = subscribe_to_application_updates(hot, (update) => {
        if (
          update.type === "compilation_error" ||
          update.type === "resource_error"
        ) {
          if (development_controller !== undefined) {
            set_development_evidence({
              type: "failed",
              revision: development_controller.active_revision(),
            });
          }
          set_runtime_notice(update.message);
          return;
        }
        if (update.type !== "game") return;
        reload_queue = reload_queue.then(async () => {
          stop_timeline();
          if (development_controller !== undefined) {
            set_development_evidence({
              type: "activating",
              revision: development_controller.active_revision(),
            });
          }
          const reload = await controller.reload();
          const next = controller.observation();
          if (next === undefined) {
            throw new Error("reloaded narrative did not publish a frame");
          }
          const loaded_project = await load_project();
          if (!active) return;
          set_presentation(next);
          set_project(loaded_project);
          set_selected_scene(loaded_project.initial_scene_id);
          set_checksum(undefined);
          if (development_controller !== undefined) {
            const activation = development_controller.activation();
            if (activation === undefined) {
              throw new Error(
                "narrative development activation did not publish evidence",
              );
            }
            set_development_evidence({
              type: "ready",
              revision: activation.revision,
              entry_retained: activation.entry_retained,
              state_preserved: reload.preserved,
            });
          }
          continue_timeline(next);
        }).catch((error) => {
          if (!active) return;
          if (development_controller !== undefined) {
            set_development_evidence({
              type: "failed",
              revision: development_controller.active_revision(),
            });
          }
          set_runtime_notice(error_message(error));
        });
      });
    }

    return () => {
      active = false;
      stop_timeline();
      continue_timeline_reference.current = () => {};
      release_updates();
      release_controller();
      controller_reference.current = null;
      void audio.close();
      void controller.close();
    };
  }, [audio]);

  const add_beat = async () => {
    if (project === undefined) return;
    if (
      project.scenes.some(({ beats }) =>
        beats.some(({ id }) => id === "signal-warning")
      )
    ) {
      set_runtime_notice("The signal warning is already authored.");
      return;
    }
    const edited = apply_narrative_command(project, {
      type: "add_beat",
      scene_id: narrative_scene_id("station"),
      beat: {
        ...signal_warning_beat,
        id: narrative_beat_id(signal_warning_beat.id),
      },
    });
    const diagnostics = validate_narrative_project(edited);
    if (has_authoring_errors(diagnostics)) {
      throw new Error(
        `narrative edit is invalid: ${
          diagnostics.map(({ message }) => message).join("; ")
        }`,
      );
    }
    set_project(edited);
    set_runtime_notice(undefined);
    try {
      const response = await fetch(narrative_project_save_url, {
        method: "PUT",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: serialize_narrative_project(edited),
      });
      if (!response.ok) {
        throw new Error(
          `narrative project save returned ${response.status}: ${await response
            .text()}`,
        );
      }
    } catch (error) {
      set_project(project);
      set_runtime_notice(error_message(error));
    }
  };

  const dispatch_story_action = async (action: GameAction) => {
    const controller = controller_reference.current;
    if (controller === null) return;
    try {
      if (action.type === "activate") {
        const activated = await audio.activate();
        set_audio_state(activated.type);
      }
      const revision = await controller.advance({
        elapsed_us: microseconds(0),
        inputs: [action],
      });
      const next = controller.observation();
      if (next === undefined) {
        throw new Error("narrative choice did not publish a frame");
      }
      if (action.type === "focus") return;
      let played_effects = 0;
      for (const effect of next.effects) {
        switch (effect.type) {
          case "play_audio":
            set_audio_state(audio.play(effect.cue).type);
            played_effects += 1;
            break;
        }
      }
      if (played_effects > 0) {
        set_audio_events((count) => count + played_effects);
      }
      set_checksum(revision.snapshot_checksum);
      set_presentation(next);
      continue_timeline_reference.current(next);
    } catch (error) {
      set_runtime_notice(error_message(error));
    }
  };

  const status = presentation?.observation.status;
  const current = presentation === undefined
    ? undefined
    : narrative_presentation(presentation);
  return (
    <main
      className="narrative-development"
      data-editor-id={narrative_editor.id}
      data-runtime-state={runtime_state}
      data-outcome={status?.done ? "ending" : "playing"}
      data-snapshot-checksum={checksum}
      data-audio-state={audio_state}
      data-audio-events={audio_events}
      data-beat-count={project?.scenes.find(({ id }) =>
        id === project.initial_scene_id
      )?.beats.length ?? 0}
      data-timeline-elapsed={current?.timeline?.elapsed_us}
      data-timeline-duration={current?.timeline?.duration_us}
      data-camera-type={presentation?.snapshot.camera.type}
      data-environment-exposure={presentation?.snapshot.environment
        .exposure_ev100}
      data-development-status={development_evidence.type}
      data-development-revision={"revision" in development_evidence
        ? development_evidence.revision
        : undefined}
      data-development-entry-retained={development_evidence.type === "ready"
        ? development_evidence.entry_retained
        : undefined}
      data-development-state-preserved={development_evidence.type === "ready"
        ? development_evidence.state_preserved
        : undefined}
    >
      <header className="application-header">
        <div>
          <small>Ink · 3D visual novel</small>
          <h1>Last Train</h1>
        </div>
        <div className="application-status">
          <output aria-live="polite">{status?.label ?? "Loading story"}</output>
          <button
            type="button"
            aria-expanded={debugger_open}
            onClick={() => set_debugger_open((open) => !open)}
          >
            Runtime log
          </button>
        </div>
      </header>
      <div className="application-columns">
        <aside className="editor-panel">
          {project === undefined
            ? <p>Loading the narrative project…</p>
            : (
              <NarrativeWorkspace
                project={project}
                selected_scene_id={selected_scene}
                onAddBeat={() => void add_beat()}
                onSelectScene={set_selected_scene}
              />
            )}
        </aside>
        <section className="story-panel" aria-label="Playable story">
          {presentation !== undefined && (
            <VisualNovelStage
              snapshot={presentation.snapshot}
              revision={presentation.observation.sequence}
            />
          )}
          {presentation !== undefined && (
            <NarrativeUi
              presentation={presentation}
              dispatch_action={dispatch_story_action}
            />
          )}
        </section>
      </div>
      {runtime_notice !== undefined && (
        <output className="runtime-notice" aria-live="assertive">
          {runtime_notice}
        </output>
      )}
      {debugger_open && (
        <DebuggerWindow
          commands={debugger_commands}
          runtime_entries={runtime_debugger_entries}
          runtime_message={status?.value ?? runtime_state}
          on_clear={() => {
            runtime_observation_log.clear();
            set_runtime_debugger_entries([]);
          }}
          on_close={() => set_debugger_open(false)}
        />
      )}
    </main>
  );
}

async function fetch_artifact(): Promise<NarrativeArtifactSource> {
  const [wasm_response, manifest_response] = await Promise.all([
    fetch(`/${artifact_name}.wasm`, { cache: "no-store" }),
    fetch(`/${artifact_name}.wasm.json`, { cache: "no-store" }),
  ]);
  if (!wasm_response.ok) {
    throw new Error(`narrative Wasm returned ${wasm_response.status}`);
  }
  if (!manifest_response.ok) {
    throw new Error(`narrative manifest returned ${manifest_response.status}`);
  }
  return {
    wasm_bytes: new Uint8Array(await wasm_response.arrayBuffer()),
    manifest_source: await manifest_response.text(),
  };
}

function browser_development_artifacts(): {
  load(path: string): Promise<Uint8Array>;
} {
  return {
    async load(path) {
      const response = await fetch(`/${path}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(
          `narrative development artifact ${
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
      `narrative development revision returned ${response.status}`,
    );
  }
  return await response.json();
}

async function import_development_runtime(): Promise<unknown> {
  const runtime_url = "/@ink/blot-development-runtime.js";
  return await import(/* @vite-ignore */ runtime_url);
}

async function load_project(): Promise<NarrativeProject> {
  const response = await fetch("/narrative-project.json", {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`narrative project returned ${response.status}`);
  }
  return parse_narrative_project(await response.text());
}

function runtime_observer(sink: ObservationSink): Observer {
  return new Observer({
    source: { subsystem: "narrative-development" },
    sink,
    clock: { now_seconds: () => performance.now() / 1_000 },
  });
}

function error_message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
