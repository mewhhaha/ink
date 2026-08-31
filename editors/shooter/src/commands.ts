import type { ShooterEncounterId } from "./identity.ts";
import {
  shooter_project,
  type ShooterCover,
  type ShooterDoor,
  type ShooterEncounter,
  type ShooterObjective,
  type ShooterProject,
  type ShooterRoom,
  type ShooterSpawn,
  type ShooterWeapon,
} from "./model.ts";

export type ShooterCommand =
  | { readonly type: "add_room"; readonly room: ShooterRoom }
  | { readonly type: "add_cover"; readonly cover: ShooterCover }
  | { readonly type: "add_spawn"; readonly spawn: ShooterSpawn }
  | { readonly type: "add_weapon"; readonly weapon: ShooterWeapon }
  | { readonly type: "add_encounter"; readonly encounter: ShooterEncounter }
  | { readonly type: "add_door"; readonly door: ShooterDoor }
  | { readonly type: "add_objective"; readonly objective: ShooterObjective }
  | {
    readonly type: "add_reinforcement";
    readonly encounter_id: ShooterEncounterId;
    readonly spawn: ShooterSpawn;
  };

export function apply_shooter_command(
  project: ShooterProject,
  command: ShooterCommand,
): ShooterProject {
  switch (command.type) {
    case "add_room": {
      require_unique(project.rooms, command.room.id, "room");
      return shooter_project({
        ...project,
        rooms: [...project.rooms, command.room],
      });
    }
    case "add_cover": {
      require_unique(project.cover, command.cover.id, "cover");
      return shooter_project({
        ...project,
        cover: [...project.cover, command.cover],
      });
    }
    case "add_spawn": {
      require_unique(project.spawns, command.spawn.id, "spawn");
      return shooter_project({
        ...project,
        spawns: [...project.spawns, command.spawn],
      });
    }
    case "add_weapon": {
      require_unique(project.weapons, command.weapon.id, "weapon");
      return shooter_project({
        ...project,
        weapons: [...project.weapons, command.weapon],
      });
    }
    case "add_encounter": {
      require_unique(project.encounters, command.encounter.id, "encounter");
      return shooter_project({
        ...project,
        encounters: [...project.encounters, command.encounter],
      });
    }
    case "add_door": {
      require_unique(project.doors, command.door.id, "door");
      return shooter_project({
        ...project,
        doors: [...project.doors, command.door],
      });
    }
    case "add_objective": {
      require_unique(
        project.objectives,
        command.objective.id,
        "objective",
      );
      return shooter_project({
        ...project,
        objectives: [...project.objectives, command.objective],
      });
    }
    case "add_reinforcement": {
      require_unique(project.spawns, command.spawn.id, "spawn");
      if (command.spawn.allegiance !== "enemy") {
        throw new Error(
          `shooter reinforcement ${command.spawn.id} allegiance ${command.spawn.allegiance} must be enemy`,
        );
      }
      const encounter = project.encounters.find(({ id }) =>
        id === command.encounter_id
      );
      if (encounter === undefined) {
        throw new Error(
          `shooter project ${project.id} has no encounter ${command.encounter_id}`,
        );
      }
      if (command.spawn.room_id !== encounter.room_id) {
        throw new Error(
          `shooter reinforcement ${command.spawn.id} room ${command.spawn.room_id} differs from encounter ${encounter.id} room ${encounter.room_id}`,
        );
      }
      return shooter_project({
        ...project,
        spawns: [...project.spawns, command.spawn],
        encounters: project.encounters.map((candidate) =>
          candidate.id === encounter.id
            ? {
              ...candidate,
              spawn_ids: [...candidate.spawn_ids, command.spawn.id],
            }
            : candidate
        ),
      });
    }
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
    throw new Error(`shooter ${label} repeats identity ${id}`);
  }
}
