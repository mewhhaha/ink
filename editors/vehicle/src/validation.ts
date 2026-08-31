import {
  authoring_diagnostic,
  type AuthoringDiagnostic,
} from "@ink/authoring/diagnostics.ts";
import type { VehicleProject } from "./model.ts";

export function validate_vehicle_project(
  project: VehicleProject,
): readonly AuthoringDiagnostic[] {
  const diagnostics: AuthoringDiagnostic[] = [];
  const waypoints = identities(
    project.waypoints,
    "DUPLICATE_WAYPOINT",
    "waypoint",
    diagnostics,
  );
  identities(
    project.checkpoints,
    "DUPLICATE_CHECKPOINT",
    "checkpoint",
    diagnostics,
  );
  identities(
    project.hazards,
    "DUPLICATE_HAZARD",
    "hazard",
    diagnostics,
  );
  if (project.waypoints.length < 2) {
    problem(
      diagnostics,
      "COURSE_TOO_SHORT",
      `${project.name} needs at least two course waypoints.`,
      "Extend the course with the Course tool.",
    );
  }
  if (project.checkpoints.length < 2) {
    problem(
      diagnostics,
      "CHECKPOINT_SEQUENCE_TOO_SHORT",
      `${project.name} needs at least two ordered checkpoints.`,
      "Place start and finish checkpoints.",
    );
  }
  const checkpoint_waypoints = new Set<string>();
  let previous_waypoint_index = -1;
  for (const checkpoint of project.checkpoints) {
    const waypoint_index = project.waypoints.findIndex(({ id }) =>
      id === checkpoint.waypoint_id
    );
    if (!waypoints.has(checkpoint.waypoint_id)) {
      problem(
        diagnostics,
        "ORPHAN_CHECKPOINT",
        `Checkpoint ${checkpoint.id} references missing waypoint ${checkpoint.waypoint_id}.`,
        "Choose an existing waypoint.",
      );
      continue;
    }
    if (checkpoint_waypoints.has(checkpoint.waypoint_id)) {
      problem(
        diagnostics,
        "DUPLICATE_CHECKPOINT_WAYPOINT",
        `Waypoint ${checkpoint.waypoint_id} has more than one checkpoint.`,
        "Keep one checkpoint at each waypoint.",
      );
    }
    checkpoint_waypoints.add(checkpoint.waypoint_id);
    if (waypoint_index <= previous_waypoint_index) {
      problem(
        diagnostics,
        "CHECKPOINT_ORDER_REVERSES_COURSE",
        `Checkpoint ${checkpoint.id} appears after a later course waypoint.`,
        "Order checkpoints in the same direction as the course waypoints.",
      );
    }
    previous_waypoint_index = waypoint_index;
  }
  for (const hazard of project.hazards) {
    if (!waypoints.has(hazard.waypoint_id)) {
      problem(
        diagnostics,
        "ORPHAN_HAZARD",
        `Hazard ${hazard.id} references missing waypoint ${hazard.waypoint_id}.`,
        "Attach the hazard to an existing waypoint.",
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
        `Vehicle ${label} ${entry.id} appears more than once.`,
        `Give every ${label} a unique identity.`,
      );
    }
    ids.add(entry.id);
  }
  return ids;
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
