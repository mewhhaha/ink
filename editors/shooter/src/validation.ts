import {
  authoring_diagnostic,
  type AuthoringDiagnostic,
} from "@ink/authoring/diagnostics.ts";
import type { ShooterProject } from "./model.ts";

export function validate_shooter_project(
  project: ShooterProject,
): readonly AuthoringDiagnostic[] {
  const diagnostics: AuthoringDiagnostic[] = [];
  const rooms = identities(
    project.rooms,
    "DUPLICATE_ROOM",
    "room",
    diagnostics,
  );
  identities(project.cover, "DUPLICATE_COVER", "cover", diagnostics);
  identities(
    project.spawns,
    "DUPLICATE_SPAWN",
    "spawn",
    diagnostics,
  );
  const spawn_by_id = new Map(project.spawns.map((spawn) => [spawn.id, spawn]));
  identities(project.weapons, "DUPLICATE_WEAPON", "weapon", diagnostics);
  identities(
    project.encounters,
    "DUPLICATE_ENCOUNTER",
    "encounter",
    diagnostics,
  );
  identities(project.doors, "DUPLICATE_DOOR", "door", diagnostics);
  const objectives = identities(
    project.objectives,
    "DUPLICATE_OBJECTIVE",
    "objective",
    diagnostics,
  );
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
    if (!rooms.has(reference.room_id)) {
      diagnostics.push(
        problem(
          "UNKNOWN_ROOM",
          `${reference.id} references missing room ${reference.room_id}.`,
          "Choose an existing room.",
        ),
      );
    }
  }
  for (const door of project.doors) {
    if (!rooms.has(door.from_room_id) || !rooms.has(door.to_room_id)) {
      diagnostics.push(
        problem(
          "UNKNOWN_DOOR_ROOM",
          `Door ${door.id} connects ${door.from_room_id} to ${door.to_room_id}, but one room is missing.`,
          "Connect two existing rooms.",
        ),
      );
    }
    if (
      door.required_objective_id !== null &&
      !objectives.has(door.required_objective_id)
    ) {
      diagnostics.push(
        problem(
          "UNKNOWN_DOOR_OBJECTIVE",
          `Door ${door.id} requires missing objective ${door.required_objective_id}.`,
          "Choose an existing objective or leave the door unlocked.",
        ),
      );
    }
  }
  for (const encounter of project.encounters) {
    const encounter_spawns = new Set<string>();
    for (const spawn_id of encounter.spawn_ids) {
      if (encounter_spawns.has(spawn_id)) {
        diagnostics.push(
          problem(
            "DUPLICATE_ENCOUNTER_SPAWN",
            `Encounter ${encounter.id} repeats spawn ${spawn_id}.`,
            "Keep each encounter spawn once.",
          ),
        );
      }
      encounter_spawns.add(spawn_id);
      const spawn = spawn_by_id.get(spawn_id);
      if (spawn === undefined) {
        diagnostics.push(
          problem(
            "UNKNOWN_ENCOUNTER_SPAWN",
            `Encounter ${encounter.id} uses missing spawn ${spawn_id}.`,
            "Choose an existing enemy spawn.",
          ),
        );
        continue;
      }
      if (spawn.allegiance !== "enemy") {
        diagnostics.push(
          problem(
            "NON_ENEMY_ENCOUNTER_SPAWN",
            `Encounter ${encounter.id} uses non-enemy spawn ${spawn_id}.`,
            "Choose an enemy spawn.",
          ),
        );
      }
      if (spawn.room_id !== encounter.room_id) {
        diagnostics.push(
          problem(
            "ENCOUNTER_SPAWN_ROOM_MISMATCH",
            `Encounter ${encounter.id} is in room ${encounter.room_id}, but spawn ${spawn_id} is in ${spawn.room_id}.`,
            "Move the spawn into the encounter room.",
          ),
        );
      }
    }
  }
  return diagnostics;
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
      diagnostics.push(
        problem(
          code,
          `Shooter ${label} ${entry.id} appears more than once.`,
          `Give every ${label} a unique identity.`,
        ),
      );
    }
    ids.add(entry.id);
  }
  return ids;
}

function problem(
  code: string,
  message: string,
  recovery: string,
): AuthoringDiagnostic {
  return authoring_diagnostic({ code, severity: "error", message, recovery });
}
