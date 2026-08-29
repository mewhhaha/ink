export type RoleplayingProjectId = string & {
  readonly __brand: "RoleplayingProjectId";
};
export type RoleplayingRegionId = string & {
  readonly __brand: "RoleplayingRegionId";
};
export type RoleplayingActorId = string & {
  readonly __brand: "RoleplayingActorId";
};
export type RoleplayingDialogueId = string & {
  readonly __brand: "RoleplayingDialogueId";
};
export type RoleplayingQuestId = string & {
  readonly __brand: "RoleplayingQuestId";
};
export type RoleplayingLootId = string & {
  readonly __brand: "RoleplayingLootId";
};
export type RoleplayingEncounterId = string & {
  readonly __brand: "RoleplayingEncounterId";
};
export type RoleplayingNavigationId = string & {
  readonly __brand: "RoleplayingNavigationId";
};

export const roleplaying_project_id = identity<RoleplayingProjectId>("project");
export const roleplaying_region_id = identity<RoleplayingRegionId>("region");
export const roleplaying_actor_id = identity<RoleplayingActorId>("actor");
export const roleplaying_dialogue_id = identity<RoleplayingDialogueId>(
  "dialogue",
);
export const roleplaying_quest_id = identity<RoleplayingQuestId>("quest");
export const roleplaying_loot_id = identity<RoleplayingLootId>("loot");
export const roleplaying_encounter_id = identity<RoleplayingEncounterId>(
  "encounter",
);
export const roleplaying_navigation_id = identity<RoleplayingNavigationId>(
  "navigation",
);

function identity<Identity extends string>(label: string) {
  return (source: string): Identity => {
    const value = source.trim();
    if (!/^[a-z][a-z0-9-]*$/.test(value)) {
      throw new Error(
        `role-playing ${label} identity ${
          JSON.stringify(source)
        } must use lowercase kebab-case`,
      );
    }
    return value as Identity;
  };
}
