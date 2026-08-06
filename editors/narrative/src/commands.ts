import type {
  NarrativeBeat,
  NarrativeChoice,
  NarrativeCondition,
  NarrativeEnding,
  NarrativeEvidence,
  NarrativeProject,
  NarrativeScene,
  NarrativeVariable,
} from "./model.ts";
export type NarrativeCommand =
  | { readonly type: "add_scene"; readonly scene: NarrativeScene }
  | {
    readonly type: "add_beat";
    readonly scene: string;
    readonly beat: NarrativeBeat;
  }
  | {
    readonly type: "add_choice";
    readonly scene: string;
    readonly choice: NarrativeChoice;
  }
  | {
    readonly type: "add_condition";
    readonly scene: string;
    readonly choice: string;
    readonly condition: NarrativeCondition;
  }
  | { readonly type: "add_variable"; readonly variable: NarrativeVariable }
  | { readonly type: "add_evidence"; readonly evidence: NarrativeEvidence }
  | { readonly type: "add_ending"; readonly ending: NarrativeEnding };
export function apply_narrative_command(
  project: NarrativeProject,
  command: NarrativeCommand,
): NarrativeProject {
  switch (command.type) {
    case "add_scene":
      return append(project, "scenes", command.scene);
    case "add_beat":
      return change_scene(
        project,
        command.scene,
        (scene) => ({
          ...scene,
          beats: append_unique(scene.beats, command.beat, "beat"),
        }),
      );
    case "add_choice":
      return change_scene(
        project,
        command.scene,
        (scene) => ({
          ...scene,
          choices: append_unique(scene.choices, command.choice, "choice"),
        }),
      );
    case "add_condition":
      return change_scene(project, command.scene, (scene) => {
        const choice_found = scene.choices.some(({ id }) =>
          id === command.choice
        );
        if (!choice_found) {
          throw new Error(
            `narrative scene ${scene.id} has no choice ${command.choice}`,
          );
        }
        return {
          ...scene,
          choices: scene.choices.map((choice) =>
            choice.id === command.choice
              ? {
                ...choice,
                conditions: [...choice.conditions, command.condition],
              }
              : choice
          ),
        };
      });
    case "add_variable":
      return append(project, "variables", command.variable);
    case "add_evidence":
      return append(project, "evidence", command.evidence);
    case "add_ending":
      return append(project, "endings", command.ending);
  }
}

function change_scene(
  project: NarrativeProject,
  scene_identity: string,
  change: (scene: NarrativeScene) => NarrativeScene,
): NarrativeProject {
  if (!project.scenes.some(({ id }) => id === scene_identity)) {
    throw new Error(`narrative project has no scene ${scene_identity}`);
  }
  return {
    ...project,
    revision: project.revision + 1,
    scenes: project.scenes.map((scene) =>
      scene.id === scene_identity ? change(scene) : scene
    ),
  };
}

function append_unique<Entry extends { readonly id: string }>(
  entries: readonly Entry[],
  entry: Entry,
  label: string,
): readonly Entry[] {
  if (entries.some(({ id }) => id === entry.id)) {
    throw new Error(`narrative ${label} repeats identity ${entry.id}`);
  }
  return [...entries, entry];
}
function append<
  Collection extends "scenes" | "variables" | "evidence" | "endings",
  Entry extends { readonly id: string },
>(
  project: NarrativeProject,
  collection: Collection,
  entry: Entry,
): NarrativeProject {
  const current: readonly { readonly id: string }[] = project[collection];
  if (current.some(({ id }) => id === entry.id)) {
    throw new Error(`narrative ${collection} repeats identity ${entry.id}`);
  }
  return {
    ...project,
    revision: project.revision + 1,
    [collection]: [...current, entry],
  } as NarrativeProject;
}
