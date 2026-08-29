import type { EditorPresetId } from "@ink/authoring/identity.ts";
import type {
  NarrativeBeatId,
  NarrativeChoiceId,
  NarrativeEndingId,
  NarrativeEvidenceId,
  NarrativeProjectId,
  NarrativeSceneId,
  NarrativeVariableId,
} from "./identity.ts";

export interface NarrativeCondition {
  readonly variable_id: NarrativeVariableId;
  readonly equals: number;
}

export interface NarrativeChoice {
  readonly id: NarrativeChoiceId;
  readonly label: string;
  readonly destination_scene_id: NarrativeSceneId;
  readonly conditions: readonly NarrativeCondition[];
  readonly reveals_evidence_ids: readonly NarrativeEvidenceId[];
}

export interface NarrativeBeat {
  readonly id: NarrativeBeatId;
  readonly speaker: string;
  readonly text: string;
}

export interface NarrativeScene {
  readonly id: NarrativeSceneId;
  readonly title: string;
  readonly beats: readonly NarrativeBeat[];
  readonly choices: readonly NarrativeChoice[];
}

export interface NarrativeVariable {
  readonly id: NarrativeVariableId;
  readonly initial: number;
}

export interface NarrativeEvidence {
  readonly id: NarrativeEvidenceId;
  readonly label: string;
}

export interface NarrativeEnding {
  readonly id: NarrativeEndingId;
  readonly scene_id: NarrativeSceneId;
  readonly label: string;
}

export interface NarrativeProject {
  readonly schema_version: 1;
  readonly id: NarrativeProjectId;
  readonly name: string;
  readonly preset_id: EditorPresetId;
  readonly initial_scene_id: NarrativeSceneId;
  readonly scenes: readonly NarrativeScene[];
  readonly variables: readonly NarrativeVariable[];
  readonly evidence: readonly NarrativeEvidence[];
  readonly endings: readonly NarrativeEnding[];
}

export function narrative_project(project: NarrativeProject): NarrativeProject {
  return Object.freeze({
    schema_version: 1,
    id: project.id,
    name: required_text(project.name, `narrative project ${project.id} name`),
    preset_id: project.preset_id,
    initial_scene_id: project.initial_scene_id,
    scenes: Object.freeze(project.scenes.map(freeze_scene)),
    variables: Object.freeze(project.variables.map((variable) =>
      Object.freeze({
        id: variable.id,
        initial: safe_integer(
          variable.initial,
          `variable ${variable.id} initial`,
        ),
      })
    )),
    evidence: Object.freeze(project.evidence.map((entry) =>
      Object.freeze({
        id: entry.id,
        label: required_text(entry.label, `evidence ${entry.id} label`),
      })
    )),
    endings: Object.freeze(project.endings.map((ending) =>
      Object.freeze({
        id: ending.id,
        scene_id: ending.scene_id,
        label: required_text(ending.label, `ending ${ending.id} label`),
      })
    )),
  });
}

function freeze_scene(scene: NarrativeScene): NarrativeScene {
  return Object.freeze({
    id: scene.id,
    title: required_text(scene.title, `scene ${scene.id} title`),
    beats: Object.freeze(scene.beats.map((beat) =>
      Object.freeze({
        id: beat.id,
        speaker: required_text(beat.speaker, `beat ${beat.id} speaker`),
        text: required_text(beat.text, `beat ${beat.id} text`),
      })
    )),
    choices: Object.freeze(scene.choices.map((choice) =>
      Object.freeze({
        id: choice.id,
        label: required_text(choice.label, `choice ${choice.id} label`),
        destination_scene_id: choice.destination_scene_id,
        conditions: Object.freeze(choice.conditions.map((condition) =>
          Object.freeze({
            variable_id: condition.variable_id,
            equals: safe_integer(
              condition.equals,
              `choice ${choice.id} condition value`,
            ),
          })
        )),
        reveals_evidence_ids: Object.freeze([...choice.reveals_evidence_ids]),
      })
    )),
  });
}

function required_text(value: string, label: string): string {
  const text = value.trim();
  if (text.length === 0) throw new Error(`${label} must not be empty`);
  return text;
}

function safe_integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} ${String(value)} must be a safe integer`);
  }
  return value;
}
