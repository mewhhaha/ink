import { apply_roleplaying_command } from "@ink/roleplaying-editor/commands.ts";
import {
  roleplaying_actor_id,
  roleplaying_loot_id,
  roleplaying_region_id,
} from "@ink/roleplaying-editor/identity.ts";
import type { RoleplayingProject } from "@ink/roleplaying-editor/model.ts";

export function add_roleplaying_loot_entry(
  project: RoleplayingProject,
  loot_id: string,
  entry: string,
): RoleplayingProject {
  return apply_roleplaying_command(project, {
    version: 2,
    type: "add_loot_entry",
    loot_id: roleplaying_loot_id(loot_id),
    entry,
  });
}

export function move_roleplaying_actor(
  project: RoleplayingProject,
  actor_id: string,
  region_id: string,
): RoleplayingProject {
  return apply_roleplaying_command(project, {
    version: 2,
    type: "move_actor",
    actor_id: roleplaying_actor_id(actor_id),
    region_id: roleplaying_region_id(region_id),
  });
}
