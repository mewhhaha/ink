import type { RoleplayingLootId } from "./identity.ts";
import {
  type NavigationLink,
  roleplaying_project,
  type RoleplayingActor,
  type RoleplayingDialogue,
  type RoleplayingEncounter,
  type RoleplayingLoot,
  type RoleplayingProject,
  type RoleplayingQuest,
  type RoleplayingRegion,
} from "./model.ts";

export type RoleplayingCommand =
  | { readonly type: "add_region"; readonly region: RoleplayingRegion }
  | { readonly type: "add_actor"; readonly actor: RoleplayingActor }
  | { readonly type: "add_dialogue"; readonly dialogue: RoleplayingDialogue }
  | { readonly type: "add_quest"; readonly quest: RoleplayingQuest }
  | { readonly type: "add_loot"; readonly loot: RoleplayingLoot }
  | {
    readonly type: "add_loot_entry";
    readonly loot_id: RoleplayingLootId;
    readonly entry: string;
  }
  | { readonly type: "add_encounter"; readonly encounter: RoleplayingEncounter }
  | { readonly type: "add_navigation"; readonly navigation: NavigationLink };

export function apply_roleplaying_command(
  project: RoleplayingProject,
  command: RoleplayingCommand,
): RoleplayingProject {
  switch (command.type) {
    case "add_region":
      require_unique(project.regions, command.region.id, "region");
      return roleplaying_project({
        ...project,
        regions: [...project.regions, command.region],
      });
    case "add_actor":
      require_unique(project.actors, command.actor.id, "actor");
      return roleplaying_project({
        ...project,
        actors: [...project.actors, command.actor],
      });
    case "add_dialogue":
      require_unique(project.dialogue, command.dialogue.id, "dialogue");
      return roleplaying_project({
        ...project,
        dialogue: [...project.dialogue, command.dialogue],
      });
    case "add_quest":
      require_unique(project.quests, command.quest.id, "quest");
      return roleplaying_project({
        ...project,
        quests: [...project.quests, command.quest],
      });
    case "add_loot":
      require_unique(project.loot, command.loot.id, "loot");
      return roleplaying_project({
        ...project,
        loot: [...project.loot, command.loot],
      });
    case "add_loot_entry": {
      const loot = project.loot.find(({ id }) => id === command.loot_id);
      if (loot === undefined) {
        throw new Error(`role-playing project has no loot ${command.loot_id}`);
      }
      const entry = command.entry.trim();
      if (entry.length === 0) {
        throw new Error("role-playing loot entry is empty");
      }
      if (loot.entries.includes(entry)) {
        throw new Error(`role-playing loot ${loot.id} repeats entry ${entry}`);
      }
      return roleplaying_project({
        ...project,
        loot: project.loot.map((candidate) =>
          candidate.id === loot.id
            ? { ...candidate, entries: [...candidate.entries, entry] }
            : candidate
        ),
      });
    }
    case "add_encounter":
      require_unique(project.encounters, command.encounter.id, "encounter");
      return roleplaying_project({
        ...project,
        encounters: [...project.encounters, command.encounter],
      });
    case "add_navigation":
      require_unique(project.navigation, command.navigation.id, "navigation");
      return roleplaying_project({
        ...project,
        navigation: [...project.navigation, command.navigation],
      });
  }
}

function require_unique(
  entries: readonly { readonly id: string }[],
  id: string,
  label: string,
): void {
  if (entries.some((entry) => entry.id === id)) {
    throw new Error(`role-playing ${label} repeats identity ${id}`);
  }
}
