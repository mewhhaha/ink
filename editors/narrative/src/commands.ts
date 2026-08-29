import type {
  NarrativeBeatId,
  NarrativeChoiceId,
  NarrativeEndingId,
  NarrativeEvidenceId,
  NarrativeSceneId,
  NarrativeVariableId,
} from "./identity.ts";
import {
  narrative_project,
  type NarrativeBeat,
  type NarrativeChoice,
  type NarrativeEnding,
  type NarrativeEvidence,
  type NarrativeProject,
  type NarrativeScene,
  type NarrativeVariable,
} from "./model.ts";

export type NarrativeCommand =
  | { readonly type: "add_scene"; readonly scene: NarrativeScene }
  | { readonly type: "remove_scene"; readonly scene_id: NarrativeSceneId }
  | {
    readonly type: "set_initial_scene";
    readonly scene_id: NarrativeSceneId;
  }
  | {
    readonly type: "add_beat";
    readonly scene_id: NarrativeSceneId;
    readonly beat: NarrativeBeat;
  }
  | {
    readonly type: "update_beat";
    readonly beat_id: NarrativeBeatId;
    readonly beat: NarrativeBeat;
  }
  | { readonly type: "remove_beat"; readonly beat_id: NarrativeBeatId }
  | {
    readonly type: "add_choice";
    readonly scene_id: NarrativeSceneId;
    readonly choice: NarrativeChoice;
  }
  | {
    readonly type: "update_choice";
    readonly choice_id: NarrativeChoiceId;
    readonly choice: NarrativeChoice;
  }
  | { readonly type: "remove_choice"; readonly choice_id: NarrativeChoiceId }
  | { readonly type: "add_variable"; readonly variable: NarrativeVariable }
  | {
    readonly type: "remove_variable";
    readonly variable_id: NarrativeVariableId;
  }
  | { readonly type: "add_evidence"; readonly evidence: NarrativeEvidence }
  | {
    readonly type: "remove_evidence";
    readonly evidence_id: NarrativeEvidenceId;
  }
  | { readonly type: "add_ending"; readonly ending: NarrativeEnding }
  | { readonly type: "remove_ending"; readonly ending_id: NarrativeEndingId };

export function apply_narrative_command(
  project: NarrativeProject,
  command: NarrativeCommand,
): NarrativeProject {
  switch (command.type) {
    case "add_scene":
      require_unique(project.scenes, command.scene.id, "scene");
      return narrative_project({
        ...project,
        scenes: [...project.scenes, command.scene],
      });
    case "remove_scene":
      require_identity(project.scenes, command.scene_id, "scene");
      return narrative_project({
        ...project,
        scenes: project.scenes.filter(({ id }) => id !== command.scene_id),
      });
    case "set_initial_scene":
      require_identity(project.scenes, command.scene_id, "scene");
      return narrative_project({
        ...project,
        initial_scene_id: command.scene_id,
      });
    case "add_beat":
      require_unique(all_beats(project), command.beat.id, "beat");
      return change_scene(project, command.scene_id, (scene) => ({
        ...scene,
        beats: [...scene.beats, command.beat],
      }));
    case "update_beat":
      require_same_identity(command.beat_id, command.beat.id, "beat");
      require_identity(all_beats(project), command.beat_id, "beat");
      return narrative_project({
        ...project,
        scenes: project.scenes.map((scene) => ({
          ...scene,
          beats: scene.beats.map((beat) =>
            beat.id === command.beat_id ? command.beat : beat
          ),
        })),
      });
    case "remove_beat":
      require_identity(all_beats(project), command.beat_id, "beat");
      return narrative_project({
        ...project,
        scenes: project.scenes.map((scene) => ({
          ...scene,
          beats: scene.beats.filter(({ id }) => id !== command.beat_id),
        })),
      });
    case "add_choice":
      require_unique(all_choices(project), command.choice.id, "choice");
      return change_scene(project, command.scene_id, (scene) => ({
        ...scene,
        choices: [...scene.choices, command.choice],
      }));
    case "update_choice":
      require_same_identity(command.choice_id, command.choice.id, "choice");
      require_identity(all_choices(project), command.choice_id, "choice");
      return narrative_project({
        ...project,
        scenes: project.scenes.map((scene) => ({
          ...scene,
          choices: scene.choices.map((choice) =>
            choice.id === command.choice_id ? command.choice : choice
          ),
        })),
      });
    case "remove_choice":
      require_identity(all_choices(project), command.choice_id, "choice");
      return narrative_project({
        ...project,
        scenes: project.scenes.map((scene) => ({
          ...scene,
          choices: scene.choices.filter(({ id }) => id !== command.choice_id),
        })),
      });
    case "add_variable":
      require_unique(project.variables, command.variable.id, "variable");
      return narrative_project({
        ...project,
        variables: [...project.variables, command.variable],
      });
    case "remove_variable":
      require_identity(project.variables, command.variable_id, "variable");
      return narrative_project({
        ...project,
        variables: project.variables.filter(({ id }) =>
          id !== command.variable_id
        ),
      });
    case "add_evidence":
      require_unique(project.evidence, command.evidence.id, "evidence");
      return narrative_project({
        ...project,
        evidence: [...project.evidence, command.evidence],
      });
    case "remove_evidence":
      require_identity(project.evidence, command.evidence_id, "evidence");
      return narrative_project({
        ...project,
        evidence: project.evidence.filter(({ id }) =>
          id !== command.evidence_id
        ),
      });
    case "add_ending":
      require_unique(project.endings, command.ending.id, "ending");
      return narrative_project({
        ...project,
        endings: [...project.endings, command.ending],
      });
    case "remove_ending":
      require_identity(project.endings, command.ending_id, "ending");
      return narrative_project({
        ...project,
        endings: project.endings.filter(({ id }) => id !== command.ending_id),
      });
  }
}

function change_scene(
  project: NarrativeProject,
  scene_id: NarrativeSceneId,
  change: (scene: NarrativeScene) => NarrativeScene,
): NarrativeProject {
  require_identity(project.scenes, scene_id, "scene");
  return narrative_project({
    ...project,
    scenes: project.scenes.map((scene) =>
      scene.id === scene_id ? change(scene) : scene
    ),
  });
}

function all_beats(project: NarrativeProject): readonly NarrativeBeat[] {
  return project.scenes.flatMap(({ beats }) => beats);
}

function all_choices(project: NarrativeProject): readonly NarrativeChoice[] {
  return project.scenes.flatMap(({ choices }) => choices);
}

function require_unique(
  entries: readonly { readonly id: string }[],
  id: string,
  label: string,
): void {
  if (entries.some((entry) => entry.id === id)) {
    throw new Error(`narrative ${label} repeats identity ${id}`);
  }
}

function require_identity(
  entries: readonly { readonly id: string }[],
  id: string,
  label: string,
): void {
  if (!entries.some((entry) => entry.id === id)) {
    throw new Error(`narrative project has no ${label} ${id}`);
  }
}

function require_same_identity(
  expected: string,
  actual: string,
  label: string,
): void {
  if (expected !== actual) {
    throw new Error(
      `narrative ${label} update expected identity ${expected}, received ${actual}`,
    );
  }
}
