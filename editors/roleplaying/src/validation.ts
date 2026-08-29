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
  const actors = identities(
    project.actors,
    "DUPLICATE_ACTOR",
    "actor",
    diagnostics,
  );
  identities(project.dialogue, "DUPLICATE_DIALOGUE", "dialogue", diagnostics);
  identities(project.quests, "DUPLICATE_QUEST", "quest", diagnostics);
  identities(project.loot, "DUPLICATE_LOOT", "loot", diagnostics);
  identities(
    project.encounters,
    "DUPLICATE_ENCOUNTER",
    "encounter",
    diagnostics,
  );
  identities(
    project.navigation,
    "DUPLICATE_NAVIGATION",
    "navigation",
    diagnostics,
  );

  if (!regions.has(project.initial_region_id)) {
    problem(
      diagnostics,
      "UNKNOWN_INITIAL_REGION",
      `Initial region ${project.initial_region_id} does not exist.`,
      "Choose an existing initial region.",
    );
  }
  if (!regions.has(project.shrine_region_id)) {
    problem(
      diagnostics,
      "UNKNOWN_SHRINE_REGION",
      `Shrine region ${project.shrine_region_id} does not exist.`,
      "Choose an existing shrine region.",
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
    require_region(quest.id, quest.region_id, regions, diagnostics);
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
  }
  for (const dialogue of project.dialogue) {
    if (!actors.has(dialogue.speaker_id)) {
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
    for (const actor_id of encounter.actor_ids) {
      if (!actors.has(actor_id)) {
        problem(
          diagnostics,
          "UNKNOWN_ENCOUNTER_ACTOR",
          `Encounter ${encounter.id} uses missing actor ${actor_id}.`,
          "Choose an existing actor.",
        );
      }
    }
  }
  const adjacency = new Map<string, Set<string>>();
  for (const link of project.navigation) {
    if (!regions.has(link.from_region_id) || !regions.has(link.to_region_id)) {
      problem(
        diagnostics,
        "UNKNOWN_NAVIGATION_REGION",
        `Navigation ${link.id} joins ${link.from_region_id} and ${link.to_region_id}, but at least one region is missing.`,
        "Join two existing regions.",
      );
      continue;
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
        "Add a directed navigation link from a reachable region.",
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
