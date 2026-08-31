import type { EditorPresetId } from "@ink/authoring/identity.ts";
import type {
  RoleplayingActorId,
  RoleplayingDialogueId,
  RoleplayingEncounterId,
  RoleplayingLootId,
  RoleplayingProjectId,
  RoleplayingQuestId,
  RoleplayingRegionId,
  RoleplayingTimelineId,
  RoleplayingTravelLinkId,
} from "./identity.ts";

export interface RoleplayingRegion {
  readonly id: RoleplayingRegionId;
  readonly label: string;
}

interface RoleplayingActorRecord {
  readonly id: RoleplayingActorId;
  readonly label: string;
  readonly region_id: RoleplayingRegionId;
}

export type RoleplayingActor =
  | RoleplayingActorRecord & {
    readonly role: "player";
    readonly maximum_health: number;
    readonly attack_damage: number;
  }
  | RoleplayingActorRecord & {
    readonly role: "enemy";
    readonly maximum_health: number;
    readonly attack_damage: number;
  }
  | RoleplayingActorRecord & {
    readonly role: "companion" | "nonplayer";
  };

export interface RoleplayingDialogue {
  readonly id: RoleplayingDialogueId;
  readonly speaker_id: RoleplayingActorId;
  readonly lines: readonly string[];
}

export interface RoleplayingQuest {
  readonly id: RoleplayingQuestId;
  readonly objective: string;
  readonly completion:
    | {
      readonly type: "reach_region";
      readonly region_id: RoleplayingRegionId;
    }
    | {
      readonly type: "deliver_loot";
      readonly region_id: RoleplayingRegionId;
      readonly loot_id: RoleplayingLootId;
    };
}

export interface RoleplayingLoot {
  readonly id: RoleplayingLootId;
  readonly region_id: RoleplayingRegionId;
  readonly entries: readonly string[];
  readonly availability:
    | { readonly type: "available" }
    | {
      readonly type: "after_encounter";
      readonly encounter_id: RoleplayingEncounterId;
    };
}

export interface RoleplayingEncounter {
  readonly id: RoleplayingEncounterId;
  readonly region_id: RoleplayingRegionId;
  readonly enemy_actor_ids: readonly RoleplayingActorId[];
}

export interface RoleplayingTravelLink {
  readonly id: RoleplayingTravelLinkId;
  readonly from_region_id: RoleplayingRegionId;
  readonly to_region_id: RoleplayingRegionId;
  readonly availability:
    | { readonly type: "available" }
    | {
      readonly type: "after_dialogue";
      readonly dialogue_id: RoleplayingDialogueId;
    }
    | {
      readonly type: "after_loot";
      readonly loot_id: RoleplayingLootId;
    };
}

interface TimedRoleplayingBeat {
  readonly time_us: number;
}

export type RoleplayingTimelineBeat =
  | TimedRoleplayingBeat & {
    readonly type: "dialogue";
    readonly dialogue_id: RoleplayingDialogueId;
  }
  | TimedRoleplayingBeat & {
    readonly type: "travel";
    readonly travel_link_id: RoleplayingTravelLinkId;
  }
  | TimedRoleplayingBeat & {
    readonly type: "encounter";
    readonly encounter_id: RoleplayingEncounterId;
  }
  | TimedRoleplayingBeat & {
    readonly type: "loot";
    readonly loot_id: RoleplayingLootId;
  }
  | TimedRoleplayingBeat & {
    readonly type: "quest";
    readonly quest_id: RoleplayingQuestId;
  };

export interface RoleplayingTimeline {
  readonly version: 1;
  readonly id: RoleplayingTimelineId;
  readonly beats: readonly RoleplayingTimelineBeat[];
}

export interface RoleplayingProject {
  readonly schema_version: 2;
  readonly id: RoleplayingProjectId;
  readonly name: string;
  readonly preset_id: EditorPresetId;
  readonly initial_region_id: RoleplayingRegionId;
  readonly regions: readonly RoleplayingRegion[];
  readonly actors: readonly RoleplayingActor[];
  readonly dialogue: readonly RoleplayingDialogue[];
  readonly quests: readonly RoleplayingQuest[];
  readonly loot: readonly RoleplayingLoot[];
  readonly encounters: readonly RoleplayingEncounter[];
  readonly travel_links: readonly RoleplayingTravelLink[];
  readonly timeline: RoleplayingTimeline;
}

export function roleplaying_project(
  project: RoleplayingProject,
): RoleplayingProject {
  return Object.freeze({
    schema_version: 2,
    id: project.id,
    name: required_text(
      project.name,
      `role-playing project ${project.id} name`,
    ),
    preset_id: project.preset_id,
    initial_region_id: project.initial_region_id,
    regions: Object.freeze(project.regions.map((region) =>
      Object.freeze({
        id: region.id,
        label: required_text(region.label, `region ${region.id} label`),
      })
    )),
    actors: Object.freeze(project.actors.map((actor) => {
      switch (actor.role) {
        case "player":
        case "enemy":
          return Object.freeze({
            id: actor.id,
            label: required_text(actor.label, `actor ${actor.id} label`),
            region_id: actor.region_id,
            role: actor.role,
            maximum_health: positive_integer(
              actor.maximum_health,
              `actor ${actor.id} maximum health`,
            ),
            attack_damage: positive_integer(
              actor.attack_damage,
              `actor ${actor.id} attack damage`,
            ),
          });
        case "companion":
        case "nonplayer":
          return Object.freeze({
            id: actor.id,
            label: required_text(actor.label, `actor ${actor.id} label`),
            region_id: actor.region_id,
            role: actor.role,
          });
      }
    })),
    dialogue: Object.freeze(project.dialogue.map((dialogue) =>
      Object.freeze({
        id: dialogue.id,
        speaker_id: dialogue.speaker_id,
        lines: nonempty_texts(
          dialogue.lines,
          `dialogue ${dialogue.id} lines`,
        ),
      })
    )),
    quests: Object.freeze(project.quests.map((quest) =>
      Object.freeze({
        id: quest.id,
        objective: required_text(
          quest.objective,
          `quest ${quest.id} objective`,
        ),
        completion: Object.freeze({ ...quest.completion }),
      })
    )),
    loot: Object.freeze(project.loot.map((loot) =>
      Object.freeze({
        id: loot.id,
        region_id: loot.region_id,
        entries: Object.freeze(loot.entries.map((entry, index) =>
          required_text(entry, `loot ${loot.id} entry ${index}`)
        )),
        availability: Object.freeze({ ...loot.availability }),
      })
    )),
    encounters: Object.freeze(
      project.encounters.map((encounter) =>
        Object.freeze({
          id: encounter.id,
          region_id: encounter.region_id,
          enemy_actor_ids: Object.freeze([...encounter.enemy_actor_ids]),
        })
      ),
    ),
    travel_links: Object.freeze(
      project.travel_links.map((link) =>
        Object.freeze({
          id: link.id,
          from_region_id: link.from_region_id,
          to_region_id: link.to_region_id,
          availability: Object.freeze({ ...link.availability }),
        })
      ),
    ),
    timeline: Object.freeze({
      version: 1,
      id: project.timeline.id,
      beats: Object.freeze(project.timeline.beats.map((beat, index) => {
        const time_us = positive_integer(
          beat.time_us,
          `timeline ${project.timeline.id} beat ${index} time_us`,
        );
        switch (beat.type) {
          case "dialogue":
            return Object.freeze({
              type: beat.type,
              time_us,
              dialogue_id: beat.dialogue_id,
            });
          case "travel":
            return Object.freeze({
              type: beat.type,
              time_us,
              travel_link_id: beat.travel_link_id,
            });
          case "encounter":
            return Object.freeze({
              type: beat.type,
              time_us,
              encounter_id: beat.encounter_id,
            });
          case "loot":
            return Object.freeze({
              type: beat.type,
              time_us,
              loot_id: beat.loot_id,
            });
          case "quest":
            return Object.freeze({
              type: beat.type,
              time_us,
              quest_id: beat.quest_id,
            });
        }
      })),
    }),
  });
}

function nonempty_texts(
  values: readonly string[],
  label: string,
): readonly string[] {
  if (values.length === 0) throw new Error(`${label} must not be empty`);
  return Object.freeze(
    values.map((value, index) => required_text(value, `${label}[${index}]`)),
  );
}

function positive_integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} ${String(value)} must be a positive integer`);
  }
  return value;
}

function required_text(value: string, label: string): string {
  const text = value.trim();
  if (text.length === 0) throw new Error(`${label} must not be empty`);
  return text;
}
