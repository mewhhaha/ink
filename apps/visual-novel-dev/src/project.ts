import { asset_id, asset_ref } from "@ink/assets/identity.ts";
import { bus_id, clip_id, command_batch } from "@ink/audio/model.ts";
import { create_catalog } from "@ink/localization/catalog.ts";
import { Localizer } from "@ink/localization/localizer.ts";
import type {
  NarrativeBeat,
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
  literal_text,
  type SemanticNode,
  ui_id,
  UiSnapshotStore,
} from "@ink/ui/semantic.ts";
import { narrative_timeline_step_us } from "./contract.ts";

export interface CompiledNarrativeProject {
  readonly blot_source: string;
  readonly canonical_source: string;
}

interface CompiledDialogue {
  readonly speaker: string;
  readonly text: string;
  readonly width: number;
  readonly height: number;
}

interface TimedDialogue extends CompiledDialogue {
  readonly order: number;
  readonly starts_at_us: number;
  readonly ends_at_us: number;
}

interface CompiledChoice {
  readonly id: string;
  readonly label: string;
  readonly destination_state: number;
  readonly ending_title: string;
  readonly ending_label: string;
  readonly ending_dialogue: CompiledDialogue;
  readonly evidence: string;
  readonly audio_cue: string;
}

const dialogue_font = create_font_family({
  family: "Narrative Test Face",
  faces: [{
    asset: asset_ref(asset_id<"font">("narrative/system-font"), "font"),
    weight: 400,
    style: "normal",
  }],
  fallbacks: ["sans-serif"],
});

const beat_duration_seconds = narrative_timeline_step_us / 1_000_000;

export function compile_narrative_project(
  source: string,
): CompiledNarrativeProject {
  const project = parse_narrative_project(source);
  const initial = required_scene(project, project.initial_scene_id);
  if (initial.choices.length !== 2) {
    throw new Error(
      `narrative scene ${initial.id} must offer exactly two choices; found ${initial.choices.length}`,
    );
  }
  for (const choice of initial.choices) {
    require_available_choice(project, choice);
  }

  const localizer = narrative_localizer();
  const timeline = create_timeline({
    id: timeline_id("narrative-beats"),
    duration: initial.beats.length * beat_duration_seconds,
    playback: "once",
    tracks: [{
      type: "events",
      id: timeline_track_id("dialogue-events"),
      events: initial.beats.map((beat, index) => ({
        time: (index + 1) * beat_duration_seconds,
        name: "present-beat",
        payload: beat.id,
      })),
    }],
  });
  const events = traverse_timeline_events(timeline, 0, timeline.duration);
  const initial_beats = events.map((event, order): TimedDialogue => {
    const beat = required_beat(initial, event.payload);
    const dialogue = compile_dialogue(initial, [beat], localizer);
    return Object.freeze({
      ...dialogue,
      order,
      starts_at_us: seconds_to_microseconds(event.occurrence_time),
      ends_at_us: seconds_to_microseconds(
        events[order + 1]?.occurrence_time ?? timeline.duration,
      ),
    });
  });
  const choices = initial.choices.map((choice, index) =>
    compile_choice(project, choice, index + 1, localizer)
  );
  return Object.freeze({
    blot_source: compile_blot_source({
      initial_title: initial.title,
      initial_beats,
      timeline_duration_us: seconds_to_microseconds(timeline.duration),
      choices,
    }),
    canonical_source: serialize_narrative_project(project),
  });
}

function compile_choice(
  project: NarrativeProject,
  choice: NarrativeChoice,
  destination_state: number,
  localizer: Localizer,
): CompiledChoice {
  const scene = required_scene(project, choice.destination_scene_id);
  const ending = required_ending(project, scene);
  const audio_commands = command_batch([{
    type: "play",
    sequence: destination_state - 1,
    presentation_time_seconds: 0,
    source: {
      type: "clip",
      id: clip_id(`narrative.choice.${choice.id}`),
    },
    bus: bus_id("narrative.dialogue"),
    gain: 0.2,
    pitch: 1,
    priority: 1,
    fade_seconds: 0,
  }]);
  const audio_command = audio_commands.commands[0];
  if (audio_command === undefined || audio_command.type !== "play") {
    throw new Error(`narrative choice ${choice.id} has no audio cue`);
  }
  return Object.freeze({
    id: choice.id,
    label: choice.label,
    destination_state,
    ending_title: scene.title,
    ending_label: ending.label,
    ending_dialogue: compile_dialogue(scene, scene.beats, localizer),
    evidence: ending_outcome(project, choice, ending),
    audio_cue: audio_command.source.id,
  });
}

function compile_dialogue(
  scene: NarrativeScene,
  beats: readonly NarrativeBeat[],
  localizer: Localizer,
): CompiledDialogue {
  const localized = beats.map((beat) =>
    localizer.resolve("narrative.beat", {
      speaker: beat.speaker,
      text: beat.text,
    })
  ).join("\n");
  const layout = layout_text({
    text: localized,
    style: {
      font: dialogue_font,
      size: 18,
      weight: 400,
      style: "normal",
      line_height: 26,
    },
    maximum_width: 560,
    wrap: "word",
  }, {
    measure(text) {
      return { width: Array.from(text).length * 8, ascent: 16, descent: 4 };
    },
  });
  const text = layout.lines.map(({ text }) => text).join("\n");
  const semantic_id = ui_id(`narrative.dialogue.${beats[0].id}`);
  const dialogue_node: SemanticNode = {
    role: "text",
    id: semantic_id,
    label: literal_text(text),
    description: literal_text(beats.map(({ speaker }) => speaker).join(", ")),
    size: { width: layout.width, height: layout.height },
  };
  const ui_result = new UiSnapshotStore().replace({
    revision: 0,
    direction: layout.direction,
    root: {
      role: "region",
      id: ui_id(`narrative.scene.${scene.id}`),
      label: literal_text(scene.title),
      layout: { type: "flex", direction: "column", gap: 8, padding: 12 },
      children: [dialogue_node],
    },
    announcements: [],
  });
  if (ui_result.type === "rejected") {
    throw new Error(
      `narrative scene ${scene.id} semantic UI is invalid: ${ui_result.reason}`,
    );
  }
  return Object.freeze({
    speaker: beats.map(({ speaker }) => speaker).join(", "),
    text,
    width: layout.width,
    height: layout.height,
  });
}

function narrative_localizer(): Localizer {
  return new Localizer({
    catalogs: [create_catalog({
      locale: "en",
      messages: {
        "narrative.beat": [
          { type: "parameter", name: "speaker" },
          { type: "text", value: ": " },
          { type: "parameter", name: "text" },
        ],
      },
    })],
    locale: "en",
  });
}

function compile_blot_source(values: {
  readonly initial_title: string;
  readonly initial_beats: readonly TimedDialogue[];
  readonly timeline_duration_us: number;
  readonly choices: readonly CompiledChoice[];
}): string {
  return `open import "blot:prelude"

const NarrativeDialogue = {
  .height = Int;
  .speaker = Text;
  .text = Text;
  .width = Int;
}

const NarrativeBeat = {
  .ends_at_us = Int;
  .height = Int;
  .order = Int;
  .speaker = Text;
  .starts_at_us = Int;
  .text = Text;
  .width = Int;
}

const NarrativeChoice = {
  .audio_cue = Text;
  .destination_state = Int;
  .ending_dialogue = NarrativeDialogue;
  .ending_label = Text;
  .ending_title = Text;
  .evidence = Text;
  .id = Text;
  .label = Text;
}

const NarrativeProject = {
  .runtime_token = Int;
  .initial_title = Text;
  .first_beat_start_us = Int;
  .initial_beats = [NarrativeBeat];
  .timeline_duration_us = Int;
  .choices = [NarrativeChoice];
}

const project :: Int -> NarrativeProject
const project = fn runtime_token => {
  .runtime_token = runtime_token;
  .initial_title = ${blot_text_literal(values.initial_title)};
  .first_beat_start_us = ${values.initial_beats[0].starts_at_us};
  .initial_beats = [
${
    values.initial_beats.map((beat) =>
      `    {
      .ends_at_us = ${beat.ends_at_us};
      .height = ${beat.height};
      .order = ${beat.order};
      .speaker = ${blot_text_literal(beat.speaker)};
      .starts_at_us = ${beat.starts_at_us};
      .text = ${blot_text_literal(beat.text)};
      .width = ${beat.width};
    }`
    ).join(",\n")
  }
  ];
  .timeline_duration_us = ${values.timeline_duration_us};
  .choices = [
${
    values.choices.map((choice) =>
      `    {
      .audio_cue = ${blot_text_literal(choice.audio_cue)};
      .destination_state = ${choice.destination_state};
      .ending_dialogue = ${blot_dialogue(choice.ending_dialogue)};
      .ending_label = ${blot_text_literal(choice.ending_label)};
      .ending_title = ${blot_text_literal(choice.ending_title)};
      .evidence = ${blot_text_literal(choice.evidence)};
      .id = ${blot_text_literal(choice.id)};
      .label = ${blot_text_literal(choice.label)};
    }`
    ).join(",\n")
  }
  ];
}

return { .project = project; }
`;
}

function blot_dialogue(dialogue: CompiledDialogue): string {
  return `{
        .height = ${dialogue.height};
        .speaker = ${blot_text_literal(dialogue.speaker)};
        .text = ${blot_text_literal(dialogue.text)};
        .width = ${dialogue.width};
      }`;
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

function required_beat(
  scene: NarrativeScene,
  beat_id: string | undefined,
): NarrativeBeat {
  const beat = scene.beats.find(({ id }) => id === beat_id);
  if (beat === undefined) {
    throw new Error(
      `narrative timeline for scene ${scene.id} references missing beat ${
        JSON.stringify(beat_id)
      }`,
    );
  }
  return beat;
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

function seconds_to_microseconds(value: number): number {
  return Math.round(value * 1_000_000);
}

function blot_text_literal(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
