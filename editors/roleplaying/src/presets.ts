import { editor_preset_id } from "@ink/authoring/identity.ts";
import {
  roleplaying_actor_id,
  roleplaying_dialogue_id,
  roleplaying_encounter_id,
  roleplaying_loot_id,
  roleplaying_project_id,
  roleplaying_quest_id,
  roleplaying_region_id,
  roleplaying_timeline_id,
  roleplaying_travel_link_id,
} from "./identity.ts";
import { roleplaying_project, type RoleplayingProject } from "./model.ts";

export function create_roleplaying_starter_project(): RoleplayingProject {
  return roleplaying_project({
    schema_version: 2,
    id: roleplaying_project_id("ruins-pilgrimage"),
    name: "The Sentinel Road",
    preset_id: editor_preset_id("dungeon-crawler"),
    initial_region_id: roleplaying_region_id("village"),
    regions: [
      { id: roleplaying_region_id("village"), label: "Keeper's Village" },
      { id: roleplaying_region_id("ruins"), label: "Old Ruins" },
      { id: roleplaying_region_id("shrine"), label: "Sunken Shrine" },
    ],
    actors: [
      {
        id: roleplaying_actor_id("hero"),
        label: "Pilgrim",
        region_id: roleplaying_region_id("village"),
        role: "player",
        maximum_health: 6,
        attack_damage: 2,
      },
      {
        id: roleplaying_actor_id("keeper"),
        label: "Village Keeper",
        region_id: roleplaying_region_id("village"),
        role: "nonplayer",
      },
      {
        id: roleplaying_actor_id("sentinel"),
        label: "Ruins Sentinel",
        region_id: roleplaying_region_id("ruins"),
        role: "enemy",
        maximum_health: 4,
        attack_damage: 1,
      },
    ],
    dialogue: [{
      id: roleplaying_dialogue_id("keeper-greeting"),
      speaker_id: roleplaying_actor_id("keeper"),
      lines: ["The ruins have awakened. Carry their relic to the shrine."],
    }],
    quests: [{
      id: roleplaying_quest_id("reach-shrine"),
      objective:
        "Defeat the sentinel, recover the ruins cache, and reach the shrine.",
      completion: {
        type: "deliver_loot",
        region_id: roleplaying_region_id("shrine"),
        loot_id: roleplaying_loot_id("ruins-cache"),
      },
    }],
    loot: [{
      id: roleplaying_loot_id("ruins-cache"),
      region_id: roleplaying_region_id("ruins"),
      entries: ["healing-herb"],
      availability: {
        type: "after_encounter",
        encounter_id: roleplaying_encounter_id("ruins-guard"),
      },
    }],
    encounters: [{
      id: roleplaying_encounter_id("ruins-guard"),
      region_id: roleplaying_region_id("ruins"),
      enemy_actor_ids: [roleplaying_actor_id("sentinel")],
    }],
    travel_links: [
      {
        id: roleplaying_travel_link_id("village-road"),
        from_region_id: roleplaying_region_id("village"),
        to_region_id: roleplaying_region_id("ruins"),
        availability: {
          type: "after_dialogue",
          dialogue_id: roleplaying_dialogue_id("keeper-greeting"),
        },
      },
      {
        id: roleplaying_travel_link_id("shrine-road"),
        from_region_id: roleplaying_region_id("ruins"),
        to_region_id: roleplaying_region_id("shrine"),
        availability: {
          type: "after_loot",
          loot_id: roleplaying_loot_id("ruins-cache"),
        },
      },
    ],
    timeline: {
      version: 1,
      id: roleplaying_timeline_id("sentinel-road"),
      beats: [
        {
          type: "dialogue",
          time_us: 250_000,
          dialogue_id: roleplaying_dialogue_id("keeper-greeting"),
        },
        {
          type: "travel",
          time_us: 500_000,
          travel_link_id: roleplaying_travel_link_id("village-road"),
        },
        {
          type: "encounter",
          time_us: 750_000,
          encounter_id: roleplaying_encounter_id("ruins-guard"),
        },
        {
          type: "loot",
          time_us: 1_250_000,
          loot_id: roleplaying_loot_id("ruins-cache"),
        },
        {
          type: "travel",
          time_us: 1_500_000,
          travel_link_id: roleplaying_travel_link_id("shrine-road"),
        },
        {
          type: "quest",
          time_us: 1_500_000,
          quest_id: roleplaying_quest_id("reach-shrine"),
        },
      ],
    },
  });
}
