import { editor_preset_id } from "../../../packages/authoring/src/identity.ts";
import type { RoleplayingProject } from "./model.ts";
export function create_roleplaying_starter_project(
  preset = editor_preset_id("tactical-crpg"),
): RoleplayingProject {
  return {
    revision: 0,
    preset,
    regions: [{ id: "village", label: "Village" }, {
      id: "ruins",
      label: "Ruins",
    }],
    actors: [{ id: "hero", region: "village", role: "player" }, {
      id: "keeper",
      region: "village",
      role: "nonplayer",
    }, { id: "sentinel", region: "ruins", role: "enemy" }],
    dialogue: [{
      id: "keeper-greeting",
      speaker: "keeper",
      lines: ["The ruins have awakened."],
    }],
    quests: [{
      id: "visit-ruins",
      region: "ruins",
      objective: "Reach the old shrine.",
    }],
    loot: [{ id: "ruins-cache", region: "ruins", entries: ["healing-herb"] }],
    encounters: [{
      id: "ruins-guard",
      region: "ruins",
      actor_ids: ["sentinel"],
    }],
    navigation: [{
      id: "village-road",
      from_region: "village",
      to_region: "ruins",
    }],
  };
}
