import {
  authoring_diagnostic,
  type AuthoringDiagnostic,
} from "@ink/authoring/diagnostics.ts";
import type { RoleplayingProject } from "./model.ts";

export function validate_roleplaying_project(
  project: RoleplayingProject,
): readonly AuthoringDiagnostic[] {
  const diagnostics: AuthoringDiagnostic[] = [];
  const regions = identities(
    project.regions,
    "DUPLICATE_REGION",
    "region",
    diagnostics,
  );
  const actor_ids = identities(
    project.actors,
    "DUPLICATE_ACTOR",
    "actor",
    diagnostics,
  );
  const dialogue_ids = identities(
    project.dialogue,
    "DUPLICATE_DIALOGUE",
    "dialogue",
    diagnostics,
  );
  const quest_ids = identities(
    project.quests,
    "DUPLICATE_QUEST",
    "quest",
    diagnostics,
  );
  const loot_ids = identities(
    project.loot,
    "DUPLICATE_LOOT",
    "loot",
    diagnostics,
  );
  const encounter_ids = identities(
    project.encounters,
    "DUPLICATE_ENCOUNTER",
    "encounter",
    diagnostics,
  );
  const travel_link_ids = identities(
    project.travel_links,
    "DUPLICATE_TRAVEL_LINK",
    "travel link",
    diagnostics,
  );

  if (project.timeline.beats.length === 0) {
    problem(
      diagnostics,
      "EMPTY_TIMELINE",
      `Role-playing timeline ${project.timeline.id} has no authored beats.`,
      "Add at least one timed dialogue, travel, encounter, loot, or quest beat.",
    );
  }
  const timeline_references = new Set<string>();
  for (const [index, beat] of project.timeline.beats.entries()) {
    const previous = project.timeline.beats[index - 1];
    if (previous !== undefined && beat.time_us < previous.time_us) {
      problem(
        diagnostics,
        "TIMELINE_TIME_ORDER",
        `Timeline beat ${index} at ${beat.time_us}us precedes beat ${
          index - 1
        } at ${previous.time_us}us.`,
        "Keep authored timeline beats in nondecreasing time order.",
      );
    }
    let reference: string;
    let known: boolean;
    switch (beat.type) {
      case "dialogue":
        reference = beat.dialogue_id;
        known = dialogue_ids.has(beat.dialogue_id);
        break;
      case "travel":
        reference = beat.travel_link_id;
        known = travel_link_ids.has(beat.travel_link_id);
        break;
      case "encounter":
        reference = beat.encounter_id;
        known = encounter_ids.has(beat.encounter_id);
        break;
      case "loot":
        reference = beat.loot_id;
        known = loot_ids.has(beat.loot_id);
        break;
      case "quest":
        reference = beat.quest_id;
        known = quest_ids.has(beat.quest_id);
        break;
    }
    const key = `${beat.type}:${reference}`;
    if (timeline_references.has(key)) {
      problem(
        diagnostics,
        "DUPLICATE_TIMELINE_BEAT",
        `Timeline ${project.timeline.id} repeats ${beat.type} beat ${reference}.`,
        "Keep one authored beat for each referenced role-playing object.",
      );
    }
    timeline_references.add(key);
    if (!known) {
      problem(
        diagnostics,
        "UNKNOWN_TIMELINE_REFERENCE",
        `Timeline ${project.timeline.id} ${beat.type} beat references missing ${reference}.`,
        `Choose an existing ${beat.type} identity.`,
      );
    }
  }

  if (!regions.has(project.initial_region_id)) {
    problem(
      diagnostics,
      "UNKNOWN_INITIAL_REGION",
      `Initial region ${project.initial_region_id} does not exist.`,
      "Choose an existing initial region.",
    );
  }
  const players = project.actors.filter(({ role }) => role === "player");
  if (players.length !== 1) {
    problem(
      diagnostics,
      "INVALID_PLAYER_COUNT",
      `Role-playing project has ${players.length} player actors; exactly one is required.`,
      "Keep exactly one player actor.",
    );
  }
  for (const actor of project.actors) {
    require_region(actor.id, actor.region_id, regions, diagnostics);
  }
  for (const quest of project.quests) {
    require_region(
      quest.id,
      quest.completion.region_id,
      regions,
      diagnostics,
    );
    if (
      quest.completion.type === "deliver_loot" &&
      !loot_ids.has(quest.completion.loot_id)
    ) {
      problem(
        diagnostics,
        "UNKNOWN_QUEST_LOOT",
        `Quest ${quest.id} requires missing loot ${quest.completion.loot_id}.`,
        "Choose existing loot for the quest completion.",
      );
    }
  }
  for (const loot of project.loot) {
    require_region(loot.id, loot.region_id, regions, diagnostics);
    const entries = new Set<string>();
    for (const entry of loot.entries) {
      if (entries.has(entry)) {
        problem(
          diagnostics,
          "DUPLICATE_LOOT_ENTRY",
          `Loot ${loot.id} repeats entry ${entry}.`,
          "Keep each loot entry once.",
        );
      }
      entries.add(entry);
    }
    if (
      loot.availability.type === "after_encounter" &&
      !encounter_ids.has(loot.availability.encounter_id)
    ) {
      problem(
        diagnostics,
        "UNKNOWN_LOOT_ENCOUNTER",
        `Loot ${loot.id} requires missing encounter ${loot.availability.encounter_id}.`,
        "Choose an existing encounter or make the loot available.",
      );
    }
  }
  for (const dialogue of project.dialogue) {
    if (!actor_ids.has(dialogue.speaker_id)) {
      problem(
        diagnostics,
        "UNKNOWN_DIALOGUE_SPEAKER",
        `Dialogue ${dialogue.id} references missing actor ${dialogue.speaker_id}.`,
        "Choose an existing speaker.",
      );
    }
  }
  for (const encounter of project.encounters) {
    require_region(encounter.id, encounter.region_id, regions, diagnostics);
    if (encounter.enemy_actor_ids.length === 0) {
      problem(
        diagnostics,
        "EMPTY_ENCOUNTER",
        `Encounter ${encounter.id} has no enemy actors.`,
        "Add at least one enemy actor.",
      );
    }
    for (const actor_id of encounter.enemy_actor_ids) {
      const actor = project.actors.find(({ id }) => id === actor_id);
      if (actor === undefined) {
        problem(
          diagnostics,
          "UNKNOWN_ENCOUNTER_ACTOR",
          `Encounter ${encounter.id} uses missing actor ${actor_id}.`,
          "Choose an existing actor.",
        );
        continue;
      }
      if (actor.role !== "enemy") {
        problem(
          diagnostics,
          "INVALID_ENCOUNTER_ACTOR",
          `Encounter ${encounter.id} actor ${actor_id} has role ${actor.role}, not enemy.`,
          "Choose an enemy actor.",
        );
      }
    }
  }
  const adjacency = new Map<string, Set<string>>();
  for (const link of project.travel_links) {
    if (!regions.has(link.from_region_id) || !regions.has(link.to_region_id)) {
      problem(
        diagnostics,
        "UNKNOWN_TRAVEL_REGION",
        `Travel link ${link.id} joins ${link.from_region_id} and ${link.to_region_id}, but at least one region is missing.`,
        "Join two existing regions.",
      );
      continue;
    }
    const availability = link.availability;
    if (
      availability.type === "after_dialogue" &&
      !project.dialogue.some(({ id }) => id === availability.dialogue_id)
    ) {
      problem(
        diagnostics,
        "UNKNOWN_TRAVEL_DIALOGUE",
        `Travel link ${link.id} requires missing dialogue ${availability.dialogue_id}.`,
        "Choose existing dialogue for the travel link.",
      );
    }
    if (
      availability.type === "after_loot" &&
      !loot_ids.has(availability.loot_id)
    ) {
      problem(
        diagnostics,
        "UNKNOWN_TRAVEL_LOOT",
        `Travel link ${link.id} requires missing loot ${availability.loot_id}.`,
        "Choose existing loot for the travel link.",
      );
    }
    const destinations = adjacency.get(link.from_region_id) ??
      new Set<string>();
    destinations.add(link.to_region_id);
    adjacency.set(link.from_region_id, destinations);
  }
  const reached = new Set<string>();
  const pending: string[] = [project.initial_region_id];
  while (pending.length > 0) {
    const region = pending.pop();
    if (region === undefined || reached.has(region)) continue;
    reached.add(region);
    for (const destination of adjacency.get(region) ?? []) {
      pending.push(destination);
    }
  }
  for (const region of project.regions) {
    if (!reached.has(region.id)) {
      problem(
        diagnostics,
        "UNREACHABLE_REGION",
        `Region ${region.id} cannot be reached from ${project.initial_region_id}.`,
        "Add a directed travel link from a reachable region.",
      );
    }
  }
  return Object.freeze(diagnostics);
}

function identities(
  entries: readonly { readonly id: string }[],
  code: string,
  label: string,
  diagnostics: AuthoringDiagnostic[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      problem(
        diagnostics,
        code,
        `Role-playing ${label} ${entry.id} appears more than once.`,
        `Give every ${label} a unique identity.`,
      );
    }
    ids.add(entry.id);
  }
  return ids;
}

function require_region(
  id: string,
  region_id: string,
  regions: ReadonlySet<string>,
  diagnostics: AuthoringDiagnostic[],
): void {
  if (!regions.has(region_id)) {
    problem(
      diagnostics,
      "UNKNOWN_REGION",
      `${id} references missing region ${region_id}.`,
      "Choose an existing region.",
    );
  }
}

function problem(
  diagnostics: AuthoringDiagnostic[],
  code: string,
  message: string,
  recovery: string,
): void {
  diagnostics.push(authoring_diagnostic({
    code,
    severity: "error",
    message,
    recovery,
  }));
}
