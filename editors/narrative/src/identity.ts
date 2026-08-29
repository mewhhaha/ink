export type NarrativeProjectId = string & {
  readonly __brand: "NarrativeProjectId";
};
export type NarrativeSceneId = string & {
  readonly __brand: "NarrativeSceneId";
};
export type NarrativeBeatId = string & { readonly __brand: "NarrativeBeatId" };
export type NarrativeChoiceId = string & {
  readonly __brand: "NarrativeChoiceId";
};
export type NarrativeVariableId = string & {
  readonly __brand: "NarrativeVariableId";
};
export type NarrativeEvidenceId = string & {
  readonly __brand: "NarrativeEvidenceId";
};
export type NarrativeEndingId = string & {
  readonly __brand: "NarrativeEndingId";
};

export const narrative_project_id = identity<NarrativeProjectId>("project");
export const narrative_scene_id = identity<NarrativeSceneId>("scene");
export const narrative_beat_id = identity<NarrativeBeatId>("beat");
export const narrative_choice_id = identity<NarrativeChoiceId>("choice");
export const narrative_variable_id = identity<NarrativeVariableId>("variable");
export const narrative_evidence_id = identity<NarrativeEvidenceId>("evidence");
export const narrative_ending_id = identity<NarrativeEndingId>("ending");

function identity<Identity extends string>(label: string) {
  return (source: string): Identity => {
    const value = source.trim();
    if (!/^[a-z][a-z0-9-]*$/.test(value)) {
      throw new Error(
        `narrative ${label} identity ${
          JSON.stringify(source)
        } must use lowercase kebab-case`,
      );
    }
    return value as Identity;
  };
}
