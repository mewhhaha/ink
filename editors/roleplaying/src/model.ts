import type { EditorPresetId } from "@ink/authoring/identity.ts";
import type {
  RoleplayingActorId,
  RoleplayingDialogueId,
  RoleplayingEncounterId,
  RoleplayingLootId,
  RoleplayingNavigationId,
  RoleplayingProjectId,
  RoleplayingQuestId,
  RoleplayingRegionId,
} from "./identity.ts";

export interface RoleplayingRegion {
  readonly id: RoleplayingRegionId;
  readonly label: string;
}

export interface RoleplayingActor {
  readonly id: RoleplayingActorId;
  readonly region_id: RoleplayingRegionId;
  readonly role: "player" | "companion" | "nonplayer" | "enemy";
}

export interface RoleplayingDialogue {
  readonly id: RoleplayingDialogueId;
  readonly speaker_id: RoleplayingActorId;
  readonly lines: readonly string[];
}

export interface RoleplayingQuest {
  readonly id: RoleplayingQuestId;
  readonly region_id: RoleplayingRegionId;
  readonly objective: string;
}

export interface RoleplayingLoot {
  readonly id: RoleplayingLootId;
  readonly region_id: RoleplayingRegionId;
  readonly entries: readonly string[];
}

export interface RoleplayingEncounter {
  readonly id: RoleplayingEncounterId;
  readonly region_id: RoleplayingRegionId;
  readonly actor_ids: readonly RoleplayingActorId[];
}

export interface NavigationLink {
  readonly id: RoleplayingNavigationId;
  readonly from_region_id: RoleplayingRegionId;
  readonly to_region_id: RoleplayingRegionId;
}

export interface RoleplayingProject {
  readonly schema_version: 1;
  readonly id: RoleplayingProjectId;
  readonly name: string;
  readonly preset_id: EditorPresetId;
  readonly initial_region_id: RoleplayingRegionId;
  readonly shrine_region_id: RoleplayingRegionId;
  readonly regions: readonly RoleplayingRegion[];
  readonly actors: readonly RoleplayingActor[];
  readonly dialogue: readonly RoleplayingDialogue[];
  readonly quests: readonly RoleplayingQuest[];
  readonly loot: readonly RoleplayingLoot[];
  readonly encounters: readonly RoleplayingEncounter[];
  readonly navigation: readonly NavigationLink[];
}

export function roleplaying_project(
  project: RoleplayingProject,
): RoleplayingProject {
  return Object.freeze({
    schema_version: 1,
    id: project.id,
    name: required_text(
      project.name,
      `role-playing project ${project.id} name`,
    ),
    preset_id: project.preset_id,
    initial_region_id: project.initial_region_id,
    shrine_region_id: project.shrine_region_id,
    regions: Object.freeze(project.regions.map((region) =>
      Object.freeze({
        id: region.id,
        label: required_text(region.label, `region ${region.id} label`),
      })
    )),
    actors: Object.freeze(project.actors.map((actor) =>
      Object.freeze({
        id: actor.id,
        region_id: actor.region_id,
        role: actor.role,
      })
    )),
    dialogue: Object.freeze(project.dialogue.map((dialogue) =>
      Object.freeze({
        id: dialogue.id,
        speaker_id: dialogue.speaker_id,
        lines: Object.freeze(dialogue.lines.map((line, index) =>
          required_text(line, `dialogue ${dialogue.id} line ${index}`)
        )),
      })
    )),
    quests: Object.freeze(project.quests.map((quest) =>
      Object.freeze({
        id: quest.id,
        region_id: quest.region_id,
        objective: required_text(
          quest.objective,
          `quest ${quest.id} objective`,
        ),
      })
    )),
    loot: Object.freeze(project.loot.map((loot) =>
      Object.freeze({
        id: loot.id,
        region_id: loot.region_id,
        entries: Object.freeze(loot.entries.map((entry, index) =>
          required_text(entry, `loot ${loot.id} entry ${index}`)
        )),
      })
    )),
    encounters: Object.freeze(
      project.encounters.map((encounter) =>
        Object.freeze({
          id: encounter.id,
          region_id: encounter.region_id,
          actor_ids: Object.freeze([...encounter.actor_ids]),
        })
      ),
    ),
    navigation: Object.freeze(project.navigation.map((link) =>
      Object.freeze({
        id: link.id,
        from_region_id: link.from_region_id,
        to_region_id: link.to_region_id,
      })
    )),
  });
}

function required_text(value: string, label: string): string {
  const text = value.trim();
  if (text.length === 0) throw new Error(`${label} must not be empty`);
  return text;
}
