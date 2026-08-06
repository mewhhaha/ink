import {
  authoring_diagnostic,
  type AuthoringDiagnostic,
} from "../../../packages/authoring/src/diagnostics.ts";
import type { RoleplayingProject } from "./model.ts";
export function validate_roleplaying_project(
  project: RoleplayingProject,
): readonly AuthoringDiagnostic[] {
  const diagnostics: AuthoringDiagnostic[] = [];
  const regions = new Set(project.regions.map(({ id }) => id));
  const actors = new Set(project.actors.map(({ id }) => id));
  if (!project.actors.some(({ role }) => role === "player")) {
    diagnostics.push(
      problem(
        "MISSING_PLAYER_ACTOR",
        "Role-playing project has no player actor.",
        "Place an actor with the player role.",
      ),
    );
  }
  for (
    const reference of [
      ...project.actors,
      ...project.quests,
      ...project.loot,
      ...project.encounters,
    ]
  ) {
    if (!regions.has(reference.region)) {
      diagnostics.push(
        problem(
          "UNKNOWN_REGION",
          `${reference.id} references missing region ${reference.region}.`,
          "Choose an existing region.",
        ),
      );
    }
  }
  for (const dialogue of project.dialogue) {
    if (!actors.has(dialogue.speaker)) {
      diagnostics.push(
        problem(
          "UNKNOWN_DIALOGUE_SPEAKER",
          `Dialogue ${dialogue.id} references missing actor ${dialogue.speaker}.`,
          "Choose an existing speaker.",
        ),
      );
    }
  }
  for (const encounter of project.encounters) {
    for (const actor of encounter.actor_ids) {
      if (!actors.has(actor)) {
        diagnostics.push(
          problem(
            "UNKNOWN_ENCOUNTER_ACTOR",
            `Encounter ${encounter.id} uses missing actor ${actor}.`,
            "Choose an existing actor.",
          ),
        );
      }
    }
  }
  for (const link of project.navigation) {
    if (!regions.has(link.from_region) || !regions.has(link.to_region)) {
      diagnostics.push(
        problem(
          "UNKNOWN_NAVIGATION_REGION",
          `Navigation ${link.id} joins missing regions ${link.from_region} and ${link.to_region}.`,
          "Join two existing regions.",
        ),
      );
    }
  }
  return diagnostics;
}
function problem(
  code: string,
  message: string,
  recovery: string,
): AuthoringDiagnostic {
  return authoring_diagnostic({ code, severity: "error", message, recovery });
}
