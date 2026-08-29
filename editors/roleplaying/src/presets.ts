import { editor_preset_id } from "@ink/authoring/identity.ts";
import {
  roleplaying_actor_id,
  roleplaying_dialogue_id,
  roleplaying_encounter_id,
  roleplaying_loot_id,
  roleplaying_navigation_id,
  roleplaying_project_id,
  roleplaying_quest_id,
  roleplaying_region_id,
} from "./identity.ts";
import { roleplaying_project, type RoleplayingProject } from "./model.ts";

export function create_roleplaying_starter_project(): RoleplayingProject {
  return roleplaying_project({
    schema_version: 1,
    id: roleplaying_project_id("ruins-pilgrimage"),
    name: "The Sentinel Road",
    preset_id: editor_preset_id("dungeon-crawler"),
    initial_region_id: roleplaying_region_id("village"),
    shrine_region_id: roleplaying_region_id("shrine"),
    regions: [
      { id: roleplaying_region_id("village"), label: "Keeper's Village" },
      { id: roleplaying_region_id("ruins"), label: "Old Ruins" },
      { id: roleplaying_region_id("shrine"), label: "Sunken Shrine" },
    ],
    actors: [
      {
        id: roleplaying_actor_id("hero"),
        region_id: roleplaying_region_id("village"),
        role: "player",
      },
      {
        id: roleplaying_actor_id("keeper"),
        region_id: roleplaying_region_id("village"),
        role: "nonplayer",
      },
      {
        id: roleplaying_actor_id("sentinel"),
        region_id: roleplaying_region_id("ruins"),
        role: "enemy",
      },
    ],
    dialogue: [{
      id: roleplaying_dialogue_id("keeper-greeting"),
      speaker_id: roleplaying_actor_id("keeper"),
      lines: ["The ruins have awakened. Carry their relic to the shrine."],
    }],
    quests: [{
      id: roleplaying_quest_id("reach-shrine"),
      region_id: roleplaying_region_id("shrine"),
      objective:
        "Defeat the sentinel, recover the ruins cache, and reach the shrine.",
    }],
    loot: [{
      id: roleplaying_loot_id("ruins-cache"),
      region_id: roleplaying_region_id("ruins"),
      entries: ["healing-herb"],
    }],
    encounters: [{
      id: roleplaying_encounter_id("ruins-guard"),
      region_id: roleplaying_region_id("ruins"),
      actor_ids: [roleplaying_actor_id("sentinel")],
    }],
    navigation: [
      {
        id: roleplaying_navigation_id("village-road"),
        from_region_id: roleplaying_region_id("village"),
        to_region_id: roleplaying_region_id("ruins"),
      },
      {
        id: roleplaying_navigation_id("shrine-road"),
        from_region_id: roleplaying_region_id("ruins"),
        to_region_id: roleplaying_region_id("shrine"),
      },
    ],
  });
}
