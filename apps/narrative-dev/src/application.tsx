/// <reference types="vite/client" />

import { has_authoring_errors } from "@ink/authoring/diagnostics.ts";
import type { GameAction, GameViewport } from "@ink/blot/protocol.ts";
import {
  blot_runtime_codec,
  type BlotPresentation,
} from "@ink/blot/runtime.ts";
import { DevelopmentController } from "@ink/development/controller.ts";
import { EditorButton } from "@ink/editor-ui/controls.tsx";
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
import { no_observations } from "@ink/observability/sink.ts";
import { microseconds } from "@ink/runtime/session.ts";
import {
  type ApplicationUpdate,
  subscribe_to_application_updates,
} from "@ink/vite/client.ts";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { create_choice_cue } from "./audio.ts";
import { narrative_project_save_url } from "./editor/project_route.ts";
import { create_narrative_guest } from "./runtime.ts";
import "@ink/editor-ui/styles.css";
import "./styles.css";

const artifact_name = "narrative_development";
const viewport: GameViewport = { width: 960, height: 540 };

interface NarrativeArtifactSource {
  readonly wasm_bytes: Uint8Array;
  readonly manifest_source: string;
}

type NarrativeController = DevelopmentController<
  GameAction,
  GameViewport,
  BlotPresentation,
  NarrativeArtifactSource
>;

export function mount_application(element: HTMLElement): void {
  createRoot(element).render(<NarrativeDevelopment />);
}

export function NarrativeDevelopment() {
  const controller_reference = useRef<NarrativeController | null>(null);
  const cue_reference = useRef(create_choice_cue());
  const [presentation, set_presentation] = useState<BlotPresentation>();
  const [project, set_project] = useState<NarrativeProject>();
  const [selected_scene, set_selected_scene] = useState("station");
  const [runtime_state, set_runtime_state] = useState("loading");
  const [runtime_notice, set_runtime_notice] = useState<string>();
  const [checksum, set_checksum] = useState<string>();
  const [audio_state, set_audio_state] = useState("idle");
  const [audio_events, set_audio_events] = useState(0);

  useEffect(() => {
    let active = true;
    let release_controller = () => {};
    let release_updates = () => {};
    const controller = new DevelopmentController({
      load_source: fetch_artifact,
      create_guest: (source) =>
        create_narrative_guest(source.wasm_bytes, source.manifest_source),
      codec: blot_runtime_codec,
      observer: runtime_observer(),
      initial_query: viewport,
    });
    controller_reference.current = controller;
    release_controller = controller.subscribe(() => {
      const state = controller.snapshot();
      if (!active) return;
      set_runtime_state(state.type);
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
        reload_queue = reload_queue.then(async () => {
          require_successful_update(update);
          await controller.reload();
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
        }).catch((error) => {
          if (active) set_runtime_notice(error_message(error));
        });
      });
    }

    return () => {
      active = false;
      release_updates();
      release_controller();
      controller_reference.current = null;
      void cue_reference.current.close();
      void controller.close();
    };
  }, []);

  const add_beat = async () => {
    if (project === undefined) return;
    if (
      project.scenes.some(({ beats }) =>
        beats.some(({ id }) => id === "platform-announcement")
      )
    ) {
      set_runtime_notice("The platform announcement is already authored.");
      return;
    }
    const edited = apply_narrative_command(project, {
      type: "add_beat",
      scene_id: narrative_scene_id("station"),
      beat: {
        id: narrative_beat_id("platform-announcement"),
        speaker: "Station",
        text: "The final service now boards from platform three.",
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

  const choose = async (action: GameAction) => {
    const controller = controller_reference.current;
    if (controller === null) return;
    const cue = await cue_reference.current.play();
    if (cue.type === "played") {
      set_audio_state(cue.context_state);
      set_audio_events((count) => count + 1);
    } else {
      set_audio_state("unavailable");
      set_runtime_notice(`Narrative audio unavailable: ${cue.reason}`);
    }
    try {
      const revision = await controller.advance({
        elapsed_us: microseconds(0),
        inputs: [action],
      });
      const next = controller.observation();
      if (next === undefined) {
        throw new Error("narrative choice did not publish a frame");
      }
      set_checksum(revision.snapshot_checksum);
      set_presentation(next);
    } catch (error) {
      set_runtime_notice(error_message(error));
    }
  };

  const reset = async () => {
    const controller = controller_reference.current;
    if (controller === null) return;
    try {
      const revision = await controller.reset();
      const next = controller.observation();
      if (next === undefined) {
        throw new Error("narrative reset did not publish a frame");
      }
      set_checksum(revision.snapshot_checksum);
      set_presentation(next);
    } catch (error) {
      set_runtime_notice(error_message(error));
    }
  };

  const status = presentation?.observation.status;
  return (
    <main
      className="narrative-development"
      data-runtime-state={runtime_state}
      data-outcome={status?.done ? "ending" : "playing"}
      data-snapshot-checksum={checksum}
      data-audio-state={audio_state}
      data-audio-events={audio_events}
      data-beat-count={project?.scenes.find(({ id }) =>
        id === project.initial_scene_id
      )?.beats
        .length ?? 0}
    >
      <header className="application-header">
        <div>
          <small>Ink · branching-vn</small>
          <h1>Narrative Development</h1>
        </div>
        <output aria-live="polite">{status?.label ?? "Loading story"}</output>
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
          <article>
            <h2>{status?.label ?? "Starting guest"}</h2>
            <p>{status?.value ?? "Loading dialogue"}</p>
          </article>
          <div className="choice-controls" aria-label="Story choices">
            {presentation?.observation.actions.filter(({ id }) =>
              id !== "restart"
            ).map(({ id, label, action }) => (
              <EditorButton
                key={id}
                tone="primary"
                onPress={() => void choose(action)}
              >
                {label}
              </EditorButton>
            ))}
            <EditorButton onPress={() => void reset()}>
              Restart story
            </EditorButton>
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

function require_successful_update(update: ApplicationUpdate): void {
  if (update.type === "compilation_error" || update.type === "resource_error") {
    throw new Error(update.message);
  }
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

async function load_project(): Promise<NarrativeProject> {
  const response = await fetch("/narrative-project.json", {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`narrative project returned ${response.status}`);
  }
  return parse_narrative_project(await response.text());
}

function runtime_observer(): Observer {
  return new Observer({
    source: { subsystem: "narrative-development" },
    sink: no_observations,
    clock: { now_seconds: () => performance.now() / 1_000 },
  });
}

function error_message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
