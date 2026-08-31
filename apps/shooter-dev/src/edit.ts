import { apply_shooter_command } from "@ink/shooter-editor/commands.ts";
import {
  shooter_encounter_id,
  shooter_room_id,
  shooter_spawn_id,
} from "@ink/shooter-editor/identity.ts";
import type { ShooterProject } from "@ink/shooter-editor/model.ts";

export function add_first_contact_reinforcement(
  project: ShooterProject,
  reinforcement_id = "reinforcement",
): ShooterProject {
  return apply_shooter_command(project, {
    type: "add_reinforcement",
    encounter_id: shooter_encounter_id("first-contact"),
    spawn: {
      id: shooter_spawn_id(reinforcement_id),
      room_id: shooter_room_id("arena"),
      allegiance: "enemy",
    },
  });
}
