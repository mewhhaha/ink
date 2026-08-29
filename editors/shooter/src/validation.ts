import {
  authoring_diagnostic,
  type AuthoringDiagnostic,
} from "@ink/authoring/diagnostics.ts";
import type { ShooterProject } from "./model.ts";

export function validate_shooter_project(
  project: ShooterProject,
): readonly AuthoringDiagnostic[] {
  const diagnostics: AuthoringDiagnostic[] = [];
  const rooms = new Set(project.rooms.map(({ id }) => id));
  const spawns = new Set(project.spawns.map(({ id }) => id));
  const objectives = new Set(project.objectives.map(({ id }) => id));
  if (!project.spawns.some(({ allegiance }) => allegiance === "player")) {
    diagnostics.push(
      problem(
        "MISSING_PLAYER_SPAWN",
        "Shooter project has no player spawn.",
        "Place a player spawn.",
      ),
    );
  }
  if (project.objectives.length === 0) {
    diagnostics.push(
      problem(
        "MISSING_OBJECTIVE",
        "Shooter project has no objective.",
        "Add a reach, interact, or eliminate objective.",
      ),
    );
  }
  for (
    const reference of [
      ...project.cover,
      ...project.spawns,
      ...project.encounters,
      ...project.objectives,
    ]
  ) {
    if (!rooms.has(reference.room)) {
      diagnostics.push(
        problem(
          "UNKNOWN_ROOM",
          `${reference.id} references missing room ${reference.room}.`,
          "Choose an existing room.",
        ),
      );
    }
  }
  for (const door of project.doors) {
    if (!rooms.has(door.from_room) || !rooms.has(door.to_room)) {
      diagnostics.push(
        problem(
          "UNKNOWN_DOOR_ROOM",
          `Door ${door.id} connects ${door.from_room} to ${door.to_room}, but one room is missing.`,
          "Connect two existing rooms.",
        ),
      );
    }
    if (door.objective !== null && !objectives.has(door.objective)) {
      diagnostics.push(
        problem(
          "UNKNOWN_DOOR_OBJECTIVE",
          `Door ${door.id} requires missing objective ${door.objective}.`,
          "Choose an existing objective or leave the door unlocked.",
        ),
      );
    }
  }
  for (const encounter of project.encounters) {
    for (const spawn of encounter.spawn_ids) {
      if (!spawns.has(spawn)) {
        diagnostics.push(
          problem(
            "UNKNOWN_ENCOUNTER_SPAWN",
            `Encounter ${encounter.id} uses missing spawn ${spawn}.`,
            "Choose an existing enemy spawn.",
          ),
        );
      }
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
