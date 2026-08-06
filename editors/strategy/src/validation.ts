import {
  authoring_diagnostic,
  type AuthoringDiagnostic,
} from "@ink/authoring/diagnostics.ts";
import type { StrategyProject } from "./model.ts";

export function validate_strategy_project(
  project: StrategyProject,
): readonly AuthoringDiagnostic[] {
  const diagnostics: AuthoringDiagnostic[] = [];
  if (!project.factions.some(({ relation }) => relation === "player")) {
    diagnostics.push(
      authoring_diagnostic({
        code: "MISSING_PLAYER_FACTION",
        severity: "error",
        message: `${project.title} has no player faction.`,
        recovery: "Add a faction controlled by the player.",
      }),
    );
  }
  if (project.objectives.length === 0) {
    diagnostics.push(
      authoring_diagnostic({
        code: "MISSING_OBJECTIVE",
        severity: "error",
        message: `${project.title} has no visible victory objective.`,
        recovery: "Create an objective with the Objective tool.",
      }),
    );
  }
  const route_ids = new Set(project.routes.map(({ id }) => id));
  for (const wave of project.waves) {
    if (!route_ids.has(wave.route)) {
      diagnostics.push(authoring_diagnostic({
        code: "ORPHAN_WAVE_ROUTE",
        severity: "error",
        message: `Wave ${wave.id} references missing route ${wave.route}.`,
        subject: wave.id,
        recovery: "Choose an existing route or draw a new one.",
      }));
    }
  }
  if (project.preset === "tower-defense" && project.waves.length === 0) {
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
