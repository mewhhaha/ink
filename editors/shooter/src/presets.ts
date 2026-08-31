import { editor_preset_id } from "@ink/authoring/identity.ts";
import {
  shooter_cover_id,
  shooter_door_id,
  shooter_encounter_id,
  shooter_objective_id,
  shooter_project_id,
  shooter_room_id,
  shooter_spawn_id,
  shooter_weapon_id,
} from "./identity.ts";
import { shooter_project, type ShooterProject } from "./model.ts";

export function create_shooter_starter_project(
  preset = editor_preset_id("boomer"),
): ShooterProject {
  const entry_room_id = shooter_room_id("entry");
  const arena_room_id = shooter_room_id("arena");
  const guard_spawn_id = shooter_spawn_id("guard");
  return shooter_project({
    schema_version: 1,
    id: shooter_project_id("first-contact"),
    name: "First Contact",
    preset_id: preset,
    rooms: [{ id: entry_room_id, label: "Entry" }, {
      id: arena_room_id,
      label: "Arena",
    }],
    cover: [{
      id: shooter_cover_id("arena-cover"),
      room_id: arena_room_id,
      protection: "low",
    }],
    spawns: [{
      id: shooter_spawn_id("player"),
      room_id: entry_room_id,
      allegiance: "player",
    }, {
      id: guard_spawn_id,
      room_id: arena_room_id,
      allegiance: "enemy",
    }],
    weapons: [{
      id: shooter_weapon_id("sidearm"),
      damage: 20,
      magazine_capacity: 12,
    }],
    encounters: [{
      id: shooter_encounter_id("first-contact"),
      room_id: arena_room_id,
      spawn_ids: [guard_spawn_id],
    }],
    doors: [{
      id: shooter_door_id("entry-door"),
      from_room_id: entry_room_id,
      to_room_id: arena_room_id,
      required_objective_id: null,
    }],
    objectives: [{
      id: shooter_objective_id("clear-arena"),
      room_id: arena_room_id,
      kind: "eliminate",
    }],
  });
}
