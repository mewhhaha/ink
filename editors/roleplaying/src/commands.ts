import type {
  NavigationLink,
  RoleplayingActor,
  RoleplayingDialogue,
  RoleplayingEncounter,
  RoleplayingLoot,
  RoleplayingProject,
  RoleplayingQuest,
  RoleplayingRegion,
} from "./model.ts";
export type RoleplayingCommand =
  | { readonly type: "add_region"; readonly region: RoleplayingRegion }
  | { readonly type: "add_actor"; readonly actor: RoleplayingActor }
  | { readonly type: "add_dialogue"; readonly dialogue: RoleplayingDialogue }
  | { readonly type: "add_quest"; readonly quest: RoleplayingQuest }
  | { readonly type: "add_loot"; readonly loot: RoleplayingLoot }
  | { readonly type: "add_encounter"; readonly encounter: RoleplayingEncounter }
  | { readonly type: "add_navigation"; readonly navigation: NavigationLink };

export function apply_roleplaying_command(
  project: RoleplayingProject,
  command: RoleplayingCommand,
): RoleplayingProject {
  switch (command.type) {
    case "add_region":
      return append(project, "regions", command.region);
    case "add_actor":
      return append(project, "actors", command.actor);
    case "add_dialogue":
      return append(project, "dialogue", command.dialogue);
    case "add_quest":
      return append(project, "quests", command.quest);
    case "add_loot":
      return append(project, "loot", command.loot);
    case "add_encounter":
      return append(project, "encounters", command.encounter);
    case "add_navigation":
      return append(project, "navigation", command.navigation);
  }
}
function append<
  Collection extends keyof RoleplayingProject,
  Entry extends { readonly id: string },
>(
  project: RoleplayingProject,
  collection: Collection,
  entry: Entry,
): RoleplayingProject {
  const current = project[collection];
  if (!Array.isArray(current)) {
    throw new Error(
      `role-playing collection ${String(collection)} is not editable`,
    );
  }
  if (
    current.some((candidate: { readonly id: string }) =>
      candidate.id === entry.id
    )
  ) {
    throw new Error(
      `role-playing ${String(collection)} repeats identity ${entry.id}`,
    );
  }
  return {
    ...project,
    revision: project.revision + 1,
    [collection]: [...current, entry],
  };
}
