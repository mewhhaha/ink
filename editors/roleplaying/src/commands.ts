import type {
  RoleplayingActorId,
  RoleplayingLootId,
  RoleplayingRegionId,
} from "./identity.ts";
import {
  roleplaying_project,
  type RoleplayingActor,
  type RoleplayingDialogue,
  type RoleplayingEncounter,
  type RoleplayingLoot,
  type RoleplayingProject,
  type RoleplayingQuest,
  type RoleplayingRegion,
  type RoleplayingTimelineBeat,
  type RoleplayingTravelLink,
} from "./model.ts";

export type RoleplayingCommand =
  & { readonly version: 2 }
  & (
    | { readonly type: "add_region"; readonly region: RoleplayingRegion }
    | { readonly type: "add_actor"; readonly actor: RoleplayingActor }
    | {
      readonly type: "move_actor";
      readonly actor_id: RoleplayingActorId;
      readonly region_id: RoleplayingRegionId;
    }
    | { readonly type: "add_dialogue"; readonly dialogue: RoleplayingDialogue }
    | { readonly type: "add_quest"; readonly quest: RoleplayingQuest }
    | { readonly type: "add_loot"; readonly loot: RoleplayingLoot }
    | {
      readonly type: "add_loot_entry";
      readonly loot_id: RoleplayingLootId;
      readonly entry: string;
    }
    | {
      readonly type: "add_encounter";
      readonly encounter: RoleplayingEncounter;
    }
    | {
      readonly type: "add_travel_link";
      readonly travel_link: RoleplayingTravelLink;
    }
    | {
      readonly type: "add_timeline_beat";
      readonly beat: RoleplayingTimelineBeat;
    }
  );

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
    case "move_actor": {
      const actor = project.actors.find(({ id }) => id === command.actor_id);
      if (actor === undefined) {
        throw new Error(
          `role-playing project has no actor ${command.actor_id}`,
        );
      }
      if (!project.regions.some(({ id }) => id === command.region_id)) {
        throw new Error(
          `role-playing project has no region ${command.region_id}`,
        );
      }
      return roleplaying_project({
        ...project,
        actors: project.actors.map((candidate) =>
          candidate.id === actor.id
            ? { ...candidate, region_id: command.region_id }
            : candidate
        ),
      });
    }
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
    case "add_travel_link":
      require_unique(
        project.travel_links,
        command.travel_link.id,
        "travel link",
      );
      return roleplaying_project({
        ...project,
        travel_links: [...project.travel_links, command.travel_link],
      });
    case "add_timeline_beat":
      return roleplaying_project({
        ...project,
        timeline: {
          ...project.timeline,
          beats: [...project.timeline.beats, command.beat],
        },
      });
  }
  const exhaustive: never = command;
  return exhaustive;
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
