import { asset_id, asset_ref } from "@ink/assets/identity.ts";
import { bus_id, command_batch, stream_id } from "@ink/audio/model.ts";
import { create_catalog } from "@ink/localization/catalog.ts";
import { Localizer } from "@ink/localization/localizer.ts";
import type {
  NarrativeChoice,
  NarrativeEnding,
  NarrativeProject,
  NarrativeScene,
} from "@ink/narrative-editor/model.ts";
import {
  parse_narrative_project,
  serialize_narrative_project,
} from "@ink/narrative-editor/serialization.ts";
import { create_font_family } from "@ink/text/font.ts";
import { layout_text } from "@ink/text/layout.ts";
import {
  create_timeline,
  timeline_id,
  timeline_track_id,
  traverse_timeline_events,
} from "@ink/timeline/timeline.ts";
import {
  flatten_semantic_tree,
  literal_text,
  type SemanticNode,
  ui_id,
  UiSnapshotStore,
} from "@ink/ui/semantic.ts";

export interface CompiledNarrativeProject {
  readonly blot_source: string;
  readonly canonical_source: string;
  readonly initial_beat_count: number;
  readonly timeline_event_count: number;
  readonly text_line_count: number;
  readonly ui_node_count: number;
  readonly audio_command_count: number;
}

export function compile_narrative_project(
  source: string,
): CompiledNarrativeProject {
  const project = parse_narrative_project(source);
  const initial = required_scene(project, project.initial_scene_id);
  const [first_choice, second_choice] = initial.choices;
  if (first_choice === undefined || second_choice === undefined) {
    throw new Error(
      `narrative scene ${initial.id} must offer exactly two choices; found ${initial.choices.length}`,
    );
  }
  if (initial.choices.length !== 2) {
    throw new Error(
      `narrative scene ${initial.id} must offer exactly two choices; found ${initial.choices.length}`,
    );
  }
  require_available_choice(project, first_choice);
  require_available_choice(project, second_choice);
  const first_scene = required_scene(
    project,
    first_choice.destination_scene_id,
  );
  const second_scene = required_scene(
    project,
    second_choice.destination_scene_id,
  );
  const first_ending = required_ending(project, first_scene);
  const second_ending = required_ending(project, second_scene);

  const catalog = create_catalog({
    locale: "en",
    messages: {
      "narrative.beat": [
        { type: "parameter", name: "speaker" },
        { type: "text", value: ": " },
        { type: "parameter", name: "text" },
      ],
    },
  });
  const localizer = new Localizer({ catalogs: [catalog], locale: "en" });
  const localized_beats = initial.beats.map((beat) =>
    localizer.resolve("narrative.beat", {
      speaker: beat.speaker,
      text: beat.text,
    })
  );
  const intro_text = localized_beats.join("\n");

  const font = create_font_family({
    family: "Narrative Test Face",
    faces: [{
      asset: asset_ref(asset_id<"font">("narrative/system-font"), "font"),
      weight: 400,
      style: "normal",
    }],
    fallbacks: ["sans-serif"],
  });
  const text_layout = layout_text({
    text: intro_text,
    style: { font, size: 16, weight: 400, style: "normal", line_height: 20 },
    maximum_width: 48,
    wrap: "word",
  }, {
    measure(text) {
      return { width: text.length, ascent: 12, descent: 4 };
    },
  });

  const beat_timeline = create_timeline({
    id: timeline_id("narrative-beats"),
    duration: initial.beats.length + 1,
    playback: "once",
    tracks: [{
      type: "events",
      id: timeline_track_id("dialogue-events"),
      events: initial.beats.map((beat, index) => ({
        time: index + 1,
        name: "present-beat",
        payload: beat.id,
      })),
    }],
  });
  const timeline_events = traverse_timeline_events(
    beat_timeline,
    0,
    beat_timeline.duration,
  );

  const root: SemanticNode = {
    role: "region",
    id: ui_id("narrative.story"),
    label: literal_text(initial.title),
    layout: { type: "flex", direction: "column", gap: 8, padding: 12 },
    children: [
      ...localized_beats.map((beat, index): SemanticNode => ({
        role: "text",
        id: ui_id(`narrative.beat.${index}`),
        label: literal_text(beat),
      })),
      ...initial.choices.map((choice): SemanticNode => ({
        role: "button",
        id: ui_id(`narrative.choice.${choice.id}`),
        label: literal_text(choice.label),
        actions: [{ id: choice.id, label: literal_text(choice.label) }],
      })),
    ],
  };
  const ui_store = new UiSnapshotStore();
  const ui_result = ui_store.replace({
    revision: 0,
    direction: "ltr",
    root,
    announcements: [],
  });
  if (ui_result.type === "rejected") {
    throw new Error(`narrative semantic UI is invalid: ${ui_result.reason}`);
  }
  const ui_node_count = flatten_semantic_tree(ui_result.snapshot.root).length;

  const audio_cues = command_batch([{
    type: "play",
    sequence: 0,
    presentation_time_seconds: 0,
    source: { type: "stream", id: stream_id("narrative-choice") },
    bus: bus_id("dialogue"),
    gain: 0.2,
    pitch: 1,
    priority: 1,
    fade_seconds: 0,
  }]);
  const intro_status =
    `${intro_text}\n${text_layout.lines.length} layout lines · ${timeline_events.length} timeline beats · ${ui_node_count} semantic nodes`;
  return Object.freeze({
    blot_source: compile_blot_source({
      initial,
      first_choice,
      second_choice,
      first_ending,
      second_ending,
      first_outcome: ending_outcome(project, first_choice, first_ending),
      second_outcome: ending_outcome(project, second_choice, second_ending),
      intro_status,
    }),
    canonical_source: serialize_narrative_project(project),
    initial_beat_count: initial.beats.length,
    timeline_event_count: timeline_events.length,
    text_line_count: text_layout.lines.length,
    ui_node_count,
    audio_command_count: audio_cues.commands.length,
  });
}

function compile_blot_source(values: {
  readonly initial: NarrativeScene;
  readonly first_choice: NarrativeChoice;
  readonly second_choice: NarrativeChoice;
  readonly first_ending: NarrativeEnding;
  readonly second_ending: NarrativeEnding;
  readonly first_outcome: string;
  readonly second_outcome: string;
  readonly intro_status: string;
}): string {
  return `return {
  .initial_title = ${blot_text_literal(values.initial.title)};
  .intro_status = ${blot_text_literal(values.intro_status)};
  .first_choice_id = ${blot_text_literal(values.first_choice.id)};
  .first_choice_label = ${blot_text_literal(values.first_choice.label)};
  .first_ending_label = ${blot_text_literal(values.first_ending.label)};
  .first_outcome = ${blot_text_literal(values.first_outcome)};
  .first_checksum = 101;
  .second_choice_id = ${blot_text_literal(values.second_choice.id)};
  .second_choice_label = ${blot_text_literal(values.second_choice.label)};
  .second_ending_label = ${blot_text_literal(values.second_ending.label)};
  .second_outcome = ${blot_text_literal(values.second_outcome)};
  .second_checksum = 202;
}
`;
}

function required_scene(
  project: NarrativeProject,
  scene_id: NarrativeProject["initial_scene_id"],
): NarrativeScene {
  const scene = project.scenes.find(({ id }) => id === scene_id);
  if (scene === undefined) {
    throw new Error(`narrative project ${project.id} has no scene ${scene_id}`);
  }
  return scene;
}

function required_ending(
  project: NarrativeProject,
  scene: NarrativeScene,
): NarrativeEnding {
  const ending = project.endings.find(({ scene_id }) => scene_id === scene.id);
  if (ending === undefined) {
    throw new Error(`narrative scene ${scene.id} has no ending`);
  }
  return ending;
}

function require_available_choice(
  project: NarrativeProject,
  choice: NarrativeChoice,
): void {
  for (const condition of choice.conditions) {
    const variable = project.variables.find(({ id }) =>
      id === condition.variable_id
    );
    if (variable === undefined) {
      throw new Error(
        `narrative choice ${choice.id} references missing variable ${condition.variable_id}`,
      );
    }
    if (variable.initial !== condition.equals) {
      throw new Error(
        `narrative choice ${choice.id} is unavailable because ${variable.id} is ${variable.initial}, expected ${condition.equals}`,
      );
    }
  }
}

function ending_outcome(
  project: NarrativeProject,
  choice: NarrativeChoice,
  ending: NarrativeEnding,
): string {
  const labels = choice.reveals_evidence_ids.map((evidence_id) => {
    const evidence = project.evidence.find(({ id }) => id === evidence_id);
    if (evidence === undefined) {
      throw new Error(
        `narrative choice ${choice.id} references missing evidence ${evidence_id}`,
      );
    }
    return evidence.label;
  });
  return `${ending.label} · Evidence: ${labels.join(", ") || "none"}`;
}

function blot_text_literal(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
