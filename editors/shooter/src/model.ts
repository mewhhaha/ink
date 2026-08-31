import type { EditorPresetId } from "@ink/authoring/identity.ts";
import type {
  ShooterCoverId,
  ShooterDoorId,
  ShooterEncounterId,
  ShooterObjectiveId,
  ShooterProjectId,
  ShooterRoomId,
  ShooterSpawnId,
  ShooterWeaponId,
} from "./identity.ts";

export interface ShooterRoom {
  readonly id: ShooterRoomId;
  readonly label: string;
}
export interface ShooterCover {
  readonly id: ShooterCoverId;
  readonly room_id: ShooterRoomId;
  readonly protection: "low" | "high";
}
export interface ShooterSpawn {
  readonly id: ShooterSpawnId;
  readonly room_id: ShooterRoomId;
  readonly allegiance: "player" | "enemy";
}
export interface ShooterWeapon {
  readonly id: ShooterWeaponId;
  readonly damage: number;
  readonly magazine_capacity: number;
}
export interface ShooterEncounter {
  readonly id: ShooterEncounterId;
  readonly room_id: ShooterRoomId;
  readonly spawn_ids: readonly ShooterSpawnId[];
}
export interface ShooterDoor {
  readonly id: ShooterDoorId;
  readonly from_room_id: ShooterRoomId;
  readonly to_room_id: ShooterRoomId;
  readonly required_objective_id: ShooterObjectiveId | null;
}
export interface ShooterObjective {
  readonly id: ShooterObjectiveId;
  readonly room_id: ShooterRoomId;
  readonly kind: "eliminate" | "reach" | "interact";
}

export interface ShooterProject {
  readonly schema_version: 1;
  readonly id: ShooterProjectId;
  readonly name: string;
  readonly preset_id: EditorPresetId;
  readonly rooms: readonly ShooterRoom[];
  readonly cover: readonly ShooterCover[];
  readonly spawns: readonly ShooterSpawn[];
  readonly weapons: readonly ShooterWeapon[];
  readonly encounters: readonly ShooterEncounter[];
  readonly doors: readonly ShooterDoor[];
  readonly objectives: readonly ShooterObjective[];
}

export function shooter_project(project: ShooterProject): ShooterProject {
  return Object.freeze({
    schema_version: 1,
    id: project.id,
    name: required_text(project.name, `shooter project ${project.id} name`),
    preset_id: project.preset_id,
    rooms: Object.freeze(project.rooms.map((room) =>
      Object.freeze({
        id: room.id,
        label: required_text(room.label, `shooter room ${room.id} label`),
      })
    )),
    cover: Object.freeze(project.cover.map((cover) =>
      Object.freeze({
        id: cover.id,
        room_id: cover.room_id,
        protection: cover.protection,
      })
    )),
    spawns: Object.freeze(project.spawns.map((spawn) =>
      Object.freeze({
        id: spawn.id,
        room_id: spawn.room_id,
        allegiance: spawn.allegiance,
      })
    )),
    weapons: Object.freeze(project.weapons.map((weapon) =>
      Object.freeze({
        id: weapon.id,
        damage: positive_integer(
          weapon.damage,
          `shooter weapon ${weapon.id} damage`,
        ),
        magazine_capacity: positive_integer(
          weapon.magazine_capacity,
          `shooter weapon ${weapon.id} magazine capacity`,
        ),
      })
    )),
    encounters: Object.freeze(
      project.encounters.map((encounter) =>
        Object.freeze({
          id: encounter.id,
          room_id: encounter.room_id,
          spawn_ids: Object.freeze([...encounter.spawn_ids]),
        })
      ),
    ),
    doors: Object.freeze(project.doors.map((door) =>
      Object.freeze({
        id: door.id,
        from_room_id: door.from_room_id,
        to_room_id: door.to_room_id,
        required_objective_id: door.required_objective_id,
      })
    )),
    objectives: Object.freeze(
      project.objectives.map((objective) =>
        Object.freeze({
          id: objective.id,
          room_id: objective.room_id,
          kind: objective.kind,
        })
      ),
    ),
  });
}

function required_text(value: string, label: string): string {
  const text = value.trim();
  if (text.length === 0) throw new Error(`${label} must not be empty`);
  return text;
}

function positive_integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} ${String(value)} must be a positive integer`);
  }
  return value;
}
