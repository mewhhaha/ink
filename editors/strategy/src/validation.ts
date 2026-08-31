import {
  authoring_diagnostic,
  type AuthoringDiagnostic,
} from "@ink/authoring/diagnostics.ts";
import type { StrategyProject } from "./model.ts";

export function validate_strategy_project(
  project: StrategyProject,
): readonly AuthoringDiagnostic[] {
  const diagnostics: AuthoringDiagnostic[] = [];
  const factions = identities(
    project.factions,
    "DUPLICATE_FACTION",
    "faction",
    diagnostics,
  );
  const structures = identities(
    project.structures,
    "DUPLICATE_STRUCTURE",
    "structure",
    diagnostics,
  );
  const routes = identities(
    project.routes,
    "DUPLICATE_ROUTE",
    "route",
    diagnostics,
  );
  identities(project.waves, "DUPLICATE_WAVE", "wave", diagnostics);
  identities(
    project.objectives,
    "DUPLICATE_OBJECTIVE",
    "objective",
    diagnostics,
  );
  duplicate_strings(
    project.resources,
    "DUPLICATE_RESOURCE",
    "resource",
    diagnostics,
  );

  const players = project.factions.filter(({ relation }) =>
    relation === "player"
  );
  if (players.length !== 1) {
    problem(
      diagnostics,
      "INVALID_PLAYER_FACTION_COUNT",
      `${project.name} has ${players.length} player factions; exactly one is required.`,
      "Keep exactly one player faction.",
    );
  }
  if (project.objectives.length === 0) {
    problem(
      diagnostics,
      "MISSING_OBJECTIVE",
      `${project.name} has no visible victory objective.`,
      "Create an objective with the Objective tool.",
    );
  }
  for (const structure of project.structures) {
    if (!factions.has(structure.faction_id)) {
      problem(
        diagnostics,
        "UNKNOWN_STRUCTURE_FACTION",
        `Structure ${structure.id} references missing faction ${structure.faction_id}.`,
        "Choose an existing faction.",
      );
    }
    require_point(project, structure.id, structure.position, diagnostics);
  }
  for (const route of project.routes) {
    for (const point of route.points) {
      require_point(project, route.id, point, diagnostics);
    }
  }
  for (const wave of project.waves) {
    if (!routes.has(wave.route_id)) {
      problem(
        diagnostics,
        "ORPHAN_WAVE_ROUTE",
        `Wave ${wave.id} references missing route ${wave.route_id}.`,
        "Choose an existing route or draw a new one.",
      );
    }
    if (!factions.has(wave.faction_id)) {
      problem(
        diagnostics,
        "UNKNOWN_WAVE_FACTION",
        `Wave ${wave.id} references missing faction ${wave.faction_id}.`,
        "Choose an existing faction.",
      );
    }
  }
  for (const objective of project.objectives) {
    const condition = objective.condition;
    switch (condition.type) {
      case "survive_waves":
      case "produce_units":
        break;
      case "destroy_structure":
      case "capture_structure":
        if (!structures.has(condition.structure_id)) {
          problem(
            diagnostics,
            "UNKNOWN_OBJECTIVE_STRUCTURE",
            `Objective ${objective.id} references missing structure ${condition.structure_id}.`,
            "Choose an existing structure.",
          );
        }
        break;
      default: {
        const exhaustive: never = condition;
        return exhaustive;
      }
    }
  }
  if (project.preset_id === "tower-defense" && project.waves.length === 0) {
    diagnostics.push(
      authoring_diagnostic({
        code: "EMPTY_WAVE_SCHEDULE",
        severity: "warning",
        message: "Tower-defense starter has no enemy waves.",
        recovery: "Schedule the first wave.",
      }),
    );
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
        `Strategy ${label} ${entry.id} appears more than once.`,
        `Give every ${label} a unique identity.`,
      );
    }
    ids.add(entry.id);
  }
  return ids;
}

function duplicate_strings(
  values: readonly string[],
  code: string,
  label: string,
  diagnostics: AuthoringDiagnostic[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      problem(
        diagnostics,
        code,
        `Strategy ${label} ${value} appears more than once.`,
        `Keep each ${label} once.`,
      );
    }
    seen.add(value);
  }
}

function require_point(
  project: StrategyProject,
  owner_id: string,
  point: { readonly x: number; readonly y: number },
  diagnostics: AuthoringDiagnostic[],
): void {
  if (
    point.x >= 0 && point.y >= 0 && point.x <= project.map.width &&
    point.y <= project.map.height
  ) return;
  problem(
    diagnostics,
    "POINT_OUTSIDE_MAP",
    `${owner_id} point (${point.x}, ${point.y}) lies outside ${project.map.width}x${project.map.height}.`,
    "Move it inside the playable map.",
  );
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
