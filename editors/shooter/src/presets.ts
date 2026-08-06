import { editor_preset_id } from "../../../packages/authoring/src/identity.ts";
import type { ShooterProject } from "./model.ts";

export function create_shooter_starter_project(
  preset = editor_preset_id("boomer"),
): ShooterProject {
  return {
    revision: 0,
    preset,
    rooms: [{ id: "entry", label: "Entry" }, { id: "arena", label: "Arena" }],
    cover: [{ id: "arena-cover", room: "arena", protection: "low" }],
    spawns: [{ id: "player", room: "entry", allegiance: "player" }, {
      id: "guard",
      room: "arena",
      allegiance: "enemy",
    }],
    weapons: [{ id: "sidearm", damage: 20, magazine: 12 }],
    encounters: [{ id: "first-contact", room: "arena", spawn_ids: ["guard"] }],
    doors: [{
      id: "entry-door",
      from_room: "entry",
      to_room: "arena",
      objective: null,
    }],
    objectives: [{ id: "clear-arena", room: "arena", kind: "eliminate" }],
  };
}
