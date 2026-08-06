import type { EditorPresetId } from "../../../packages/authoring/src/identity.ts";

export interface RoleplayingRegion {
  readonly id: string;
  readonly label: string;
}
export interface RoleplayingActor {
  readonly id: string;
  readonly region: string;
  readonly role: "player" | "companion" | "nonplayer" | "enemy";
}
export interface RoleplayingDialogue {
  readonly id: string;
  readonly speaker: string;
  readonly lines: readonly string[];
}
export interface RoleplayingQuest {
  readonly id: string;
  readonly region: string;
  readonly objective: string;
}
export interface RoleplayingLoot {
  readonly id: string;
  readonly region: string;
  readonly entries: readonly string[];
}
export interface RoleplayingEncounter {
  readonly id: string;
  readonly region: string;
  readonly actor_ids: readonly string[];
}
export interface NavigationLink {
  readonly id: string;
  readonly from_region: string;
  readonly to_region: string;
}
export interface RoleplayingProject {
  readonly revision: number;
  readonly preset: EditorPresetId;
  readonly regions: readonly RoleplayingRegion[];
  readonly actors: readonly RoleplayingActor[];
  readonly dialogue: readonly RoleplayingDialogue[];
  readonly quests: readonly RoleplayingQuest[];
  readonly loot: readonly RoleplayingLoot[];
  readonly encounters: readonly RoleplayingEncounter[];
  readonly navigation: readonly NavigationLink[];
}
