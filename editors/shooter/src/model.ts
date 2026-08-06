import type { EditorPresetId } from "../../../packages/authoring/src/identity.ts";

export interface ShooterRoom {
  readonly id: string;
  readonly label: string;
}
export interface ShooterCover {
  readonly id: string;
  readonly room: string;
  readonly protection: "low" | "high";
}
export interface ShooterSpawn {
  readonly id: string;
  readonly room: string;
  readonly allegiance: "player" | "enemy";
}
export interface ShooterWeapon {
  readonly id: string;
  readonly damage: number;
  readonly magazine: number;
}
export interface ShooterEncounter {
  readonly id: string;
  readonly room: string;
  readonly spawn_ids: readonly string[];
}
export interface ShooterDoor {
  readonly id: string;
  readonly from_room: string;
  readonly to_room: string;
  readonly objective: string | null;
}
export interface ShooterObjective {
  readonly id: string;
  readonly room: string;
  readonly kind: "eliminate" | "reach" | "interact";
}

export interface ShooterProject {
  readonly revision: number;
  readonly preset: EditorPresetId;
  readonly rooms: readonly ShooterRoom[];
  readonly cover: readonly ShooterCover[];
  readonly spawns: readonly ShooterSpawn[];
  readonly weapons: readonly ShooterWeapon[];
  readonly encounters: readonly ShooterEncounter[];
  readonly doors: readonly ShooterDoor[];
  readonly objectives: readonly ShooterObjective[];
}
