import type {
  ShooterCover,
  ShooterDoor,
  ShooterEncounter,
  ShooterObjective,
  ShooterProject,
  ShooterRoom,
  ShooterSpawn,
  ShooterWeapon,
} from "./model.ts";

export type ShooterCommand =
  | { readonly type: "add_room"; readonly room: ShooterRoom }
  | { readonly type: "add_cover"; readonly cover: ShooterCover }
  | { readonly type: "add_spawn"; readonly spawn: ShooterSpawn }
  | { readonly type: "add_weapon"; readonly weapon: ShooterWeapon }
  | { readonly type: "add_encounter"; readonly encounter: ShooterEncounter }
  | { readonly type: "add_door"; readonly door: ShooterDoor }
  | { readonly type: "add_objective"; readonly objective: ShooterObjective };

export function apply_shooter_command(
  project: ShooterProject,
  command: ShooterCommand,
): ShooterProject {
  switch (command.type) {
    case "add_room":
      return append(project, "rooms", command.room);
    case "add_cover":
      return append(project, "cover", command.cover);
    case "add_spawn":
      return append(project, "spawns", command.spawn);
    case "add_weapon":
      return append(project, "weapons", command.weapon);
    case "add_encounter":
      return append(project, "encounters", command.encounter);
    case "add_door":
      return append(project, "doors", command.door);
    case "add_objective":
      return append(project, "objectives", command.objective);
  }
}

function append<Entry extends { readonly id: string }>(
  project: ShooterProject,
  collection:
    | "rooms"
    | "cover"
    | "spawns"
    | "weapons"
    | "encounters"
    | "doors"
    | "objectives",
  entry: Entry,
): ShooterProject {
  const current: readonly { readonly id: string }[] = project[collection];
  if (current.some(({ id }) => id === entry.id)) {
    throw new Error(`shooter ${collection} repeats identity ${entry.id}`);
  }
  return {
    ...project,
    revision: project.revision + 1,
    [collection]: [...current, entry],
  } as ShooterProject;
}
