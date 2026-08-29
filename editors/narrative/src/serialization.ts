import { editor_preset_id } from "@ink/authoring/identity.ts";
import { narrative_presets } from "./catalog.ts";
import {
  narrative_beat_id,
  narrative_choice_id,
  narrative_ending_id,
  narrative_evidence_id,
  narrative_project_id,
  narrative_scene_id,
  narrative_variable_id,
} from "./identity.ts";
import {
  narrative_project,
  type NarrativeBeat,
  type NarrativeChoice,
  type NarrativeCondition,
  type NarrativeEnding,
  type NarrativeEvidence,
  type NarrativeProject,
  type NarrativeScene,
  type NarrativeVariable,
} from "./model.ts";
import { validate_narrative_project } from "./validation.ts";

export function parse_narrative_project(
  source: string,
  source_name = "narrative project",
): NarrativeProject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error(`${source_name} is not valid JSON`, { cause });
  }
  const root = exact_record(parsed, [
    "endings",
    "evidence",
    "id",
    "initial_scene_id",
    "name",
    "preset_id",
    "scenes",
    "schema_version",
    "variables",
  ], source_name);
  if (root.schema_version !== 1) {
    throw new Error(
      `${source_name} schema version ${
        JSON.stringify(root.schema_version)
      } is unsupported`,
    );
  }
  const preset_id = text(root.preset_id, `${source_name} preset_id`);
  if (!narrative_presets.some(({ id }) => id === preset_id)) {
    throw new Error(
      `${source_name} preset ${JSON.stringify(preset_id)} is unsupported`,
    );
  }
  const project = narrative_project({
    schema_version: 1,
    id: narrative_project_id(text(root.id, `${source_name} id`)),
    name: text(root.name, `${source_name} name`),
    preset_id: editor_preset_id(preset_id),
    initial_scene_id: narrative_scene_id(
      text(root.initial_scene_id, `${source_name} initial_scene_id`),
    ),
    scenes: array(root.scenes, `${source_name} scenes`).map((entry, index) =>
      parse_scene(entry, `${source_name} scenes[${index}]`)
    ),
    variables: array(root.variables, `${source_name} variables`).map(
      (entry, index) =>
        parse_variable(entry, `${source_name} variables[${index}]`),
    ),
    evidence: array(root.evidence, `${source_name} evidence`).map(
      (entry, index) =>
        parse_evidence(entry, `${source_name} evidence[${index}]`),
    ),
    endings: array(root.endings, `${source_name} endings`).map((entry, index) =>
      parse_ending(entry, `${source_name} endings[${index}]`)
    ),
  });
  const errors = validate_narrative_project(project).filter(({ severity }) =>
    severity === "error"
  );
  if (errors.length > 0) {
    throw new Error(
      `${source_name} is invalid: ${
        errors.map(({ message }) => message).join("; ")
      }`,
    );
  }
  return project;
}

export function serialize_narrative_project(project: NarrativeProject): string {
  const canonical = {
    schema_version: project.schema_version,
    id: project.id,
    name: project.name,
    preset_id: project.preset_id,
    initial_scene_id: project.initial_scene_id,
    variables: project.variables.map((variable) => ({
      id: variable.id,
      initial: variable.initial,
    })),
    evidence: project.evidence.map((entry) => ({
      id: entry.id,
      label: entry.label,
    })),
    scenes: project.scenes.map((scene) => ({
      id: scene.id,
      title: scene.title,
      beats: scene.beats.map((beat) => ({
        id: beat.id,
        speaker: beat.speaker,
        text: beat.text,
      })),
      choices: scene.choices.map((choice) => ({
        id: choice.id,
        label: choice.label,
        destination_scene_id: choice.destination_scene_id,
        conditions: choice.conditions.map((condition) => ({
          variable_id: condition.variable_id,
          equals: condition.equals,
        })),
        reveals_evidence_ids: [...choice.reveals_evidence_ids],
      })),
    })),
    endings: project.endings.map((ending) => ({
      id: ending.id,
      scene_id: ending.scene_id,
      label: ending.label,
    })),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function parse_scene(value: unknown, label: string): NarrativeScene {
  const scene = exact_record(value, ["beats", "choices", "id", "title"], label);
  return {
    id: narrative_scene_id(text(scene.id, `${label} id`)),
    title: text(scene.title, `${label} title`),
    beats: array(scene.beats, `${label} beats`).map((entry, index) =>
      parse_beat(entry, `${label} beats[${index}]`)
    ),
    choices: array(scene.choices, `${label} choices`).map((entry, index) =>
      parse_choice(entry, `${label} choices[${index}]`)
    ),
  };
}

function parse_beat(value: unknown, label: string): NarrativeBeat {
  const beat = exact_record(value, ["id", "speaker", "text"], label);
  return {
    id: narrative_beat_id(text(beat.id, `${label} id`)),
    speaker: text(beat.speaker, `${label} speaker`),
    text: text(beat.text, `${label} text`),
  };
}

function parse_choice(value: unknown, label: string): NarrativeChoice {
  const choice = exact_record(value, [
    "conditions",
    "destination_scene_id",
    "id",
    "label",
    "reveals_evidence_ids",
  ], label);
  return {
    id: narrative_choice_id(text(choice.id, `${label} id`)),
    label: text(choice.label, `${label} label`),
    destination_scene_id: narrative_scene_id(
      text(choice.destination_scene_id, `${label} destination_scene_id`),
    ),
    conditions: array(choice.conditions, `${label} conditions`).map(
      (entry, index) => parse_condition(entry, `${label} conditions[${index}]`),
    ),
    reveals_evidence_ids: array(
      choice.reveals_evidence_ids,
      `${label} reveals_evidence_ids`,
    ).map((entry, index) =>
      narrative_evidence_id(
        text(entry, `${label} reveals_evidence_ids[${index}]`),
      )
    ),
  };
}

function parse_condition(value: unknown, label: string): NarrativeCondition {
  const condition = exact_record(value, ["equals", "variable_id"], label);
  return {
    variable_id: narrative_variable_id(
      text(condition.variable_id, `${label} variable_id`),
    ),
    equals: safe_integer(condition.equals, `${label} equals`),
  };
}

function parse_variable(value: unknown, label: string): NarrativeVariable {
  const variable = exact_record(value, ["id", "initial"], label);
  return {
    id: narrative_variable_id(text(variable.id, `${label} id`)),
    initial: safe_integer(variable.initial, `${label} initial`),
  };
}

function parse_evidence(value: unknown, label: string): NarrativeEvidence {
  const evidence = exact_record(value, ["id", "label"], label);
  return {
    id: narrative_evidence_id(text(evidence.id, `${label} id`)),
    label: text(evidence.label, `${label} label`),
  };
}

function parse_ending(value: unknown, label: string): NarrativeEnding {
  const ending = exact_record(value, ["id", "label", "scene_id"], label);
  return {
    id: narrative_ending_id(text(ending.id, `${label} id`)),
    scene_id: narrative_scene_id(text(ending.scene_id, `${label} scene_id`)),
    label: text(ending.label, `${label} label`),
  };
}

function exact_record(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = Object.fromEntries(Object.entries(value));
  const expected = new Set(fields);
  const missing = fields.filter((field) => !(field in record));
  const unknown = Object.keys(record).filter((field) => !expected.has(field));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${label} fields differ; missing [${missing.join(", ")}], unknown [${
        unknown.join(", ")
      }]`,
    );
  }
  return record;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function safe_integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} ${JSON.stringify(value)} must be a safe integer`);
  }
  return value;
}
