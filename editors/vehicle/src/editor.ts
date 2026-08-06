import { specialized_editor_descriptor } from "@ink/authoring/catalog.ts";
import {
  authoring_diagnostic,
  type AuthoringDiagnostic,
} from "@ink/authoring/diagnostics.ts";
import {
  editor_preset_id,
  editor_tool_id,
  type EditorPresetId,
  specialized_editor_id,
} from "@ink/authoring/identity.ts";

export interface VehicleWaypoint {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly speed_limit: number;
}

export interface VehicleCheckpoint {
  readonly id: string;
  readonly waypoint: string;
  readonly order: number;
}

export interface VehicleHazard {
  readonly id: string;
  readonly waypoint: string;
  readonly kind: "obstacle" | "weather" | "enemy" | "depth";
}

export interface VehicleProject {
  readonly title: string;
  readonly preset: EditorPresetId;
  readonly player_vehicle: string;
  readonly waypoints: readonly VehicleWaypoint[];
  readonly checkpoints: readonly VehicleCheckpoint[];
  readonly hazards: readonly VehicleHazard[];
  readonly objective: "finish" | "survive" | "escort" | "destroy-target";
  readonly laps: number;
}

export const vehicle_editor = specialized_editor_descriptor({
  id: specialized_editor_id("vehicle"),
  label: "Vehicle",
  summary:
    "Shape courses, routes, vehicles, checkpoints, hazards, and objectives.",
  vocabulary: [
    "vehicle",
    "course",
    "waypoint",
    "checkpoint",
    "hazard",
    "objective",
  ],
  tools: [
    ["place-vehicle", "Vehicle", "Choose and place the player's vehicle."],
    ["draw-course", "Course", "Draw an ordered route through space."],
    ["place-checkpoint", "Checkpoint", "Add an ordered course checkpoint."],
    ["place-hazard", "Hazard", "Attach an obstacle or threat to the route."],
    ["set-objective", "Objective", "Choose the scenario completion rule."],
  ].map(([id, label, purpose]) => ({ id: editor_tool_id(id), label, purpose })),
  presets: [
    [
      "racer",
      "Racer",
      "Lap courses, checkpoints, opponents, and split times.",
      ["lap timing", "racing line", "checkpoint order"],
    ],
    [
      "arcade-flight",
      "Arcade Flight",
      "Three-dimensional routes, targets, and boost gates.",
      ["flight path", "target run", "boost gate"],
    ],
    [
      "submarine",
      "Submarine",
      "Depth routes, sonar contacts, pressure, and objectives.",
      ["depth control", "sonar", "pressure hazard"],
    ],
    [
      "space-combat",
      "Space Combat",
      "Zero-gravity routes, formations, and combat objectives.",
      ["six-axis motion", "formation", "target objective"],
    ],
  ].map(([id, label, summary, characteristic_mechanics]) => ({
    id: editor_preset_id(id as string),
    label: label as string,
    summary: summary as string,
    characteristic_mechanics: characteristic_mechanics as string[],
  })),
});

export function create_vehicle_starter(preset: string): VehicleProject {
  const selected = vehicle_editor.presets.find(({ id }) => id === preset);
  if (selected === undefined) {
    throw new Error(`vehicle preset ${JSON.stringify(preset)} is unavailable`);
  }
  const depth = selected.id === "submarine" ? -20 : 0;
  return Object.freeze({
    title: `${selected.label} Starter`,
    preset: selected.id,
    player_vehicle: selected.id === "submarine"
      ? "survey-submarine"
      : "starter-vehicle",
    waypoints: Object.freeze([
      { id: "start", x: 0, y: depth, z: 0, speed_limit: 20 },
      { id: "turn", x: 50, y: depth, z: 35, speed_limit: 12 },
      { id: "finish", x: 100, y: depth, z: 0, speed_limit: 20 },
    ]),
    checkpoints: Object.freeze([
      { id: "checkpoint-start", waypoint: "start", order: 0 },
      { id: "checkpoint-turn", waypoint: "turn", order: 1 },
      { id: "checkpoint-finish", waypoint: "finish", order: 2 },
    ]),
    hazards: Object.freeze(
      selected.id === "submarine"
        ? [{ id: "trench", waypoint: "turn", kind: "depth" as const }]
        : [],
    ),
    objective: "finish",
    laps: selected.id === "racer" ? 3 : 1,
  });
}

export function append_vehicle_waypoint(
  project: VehicleProject,
  waypoint: VehicleWaypoint,
): VehicleProject {
  if (project.waypoints.some(({ id }) => id === waypoint.id)) {
    throw new Error(`vehicle waypoint repeats ${waypoint.id}`);
  }
  if (
    ![waypoint.x, waypoint.y, waypoint.z, waypoint.speed_limit].every(
      Number.isFinite,
    ) || waypoint.speed_limit <= 0
  ) {
    throw new Error(
      `vehicle waypoint ${waypoint.id} has invalid position or speed ${waypoint.speed_limit}`,
    );
  }
  return Object.freeze({
    ...project,
    waypoints: Object.freeze([...project.waypoints, Object.freeze(waypoint)]),
  });
}

export function validate_vehicle_project(
  project: VehicleProject,
): readonly AuthoringDiagnostic[] {
  const diagnostics: AuthoringDiagnostic[] = [];
  if (project.player_vehicle.trim().length === 0) {
    diagnostics.push(
      authoring_diagnostic({
        code: "MISSING_PLAYER_VEHICLE",
        severity: "error",
        message: `${project.title} has no player vehicle.`,
        recovery: "Choose a vehicle with the Vehicle tool.",
      }),
    );
  }
  if (project.waypoints.length < 2) {
    diagnostics.push(
      authoring_diagnostic({
        code: "COURSE_TOO_SHORT",
        severity: "error",
        message: `${project.title} needs at least two course waypoints.`,
        recovery: "Extend the course with the Course tool.",
      }),
    );
  }
  const waypoints = new Set(project.waypoints.map(({ id }) => id));
  for (const checkpoint of project.checkpoints) {
    if (!waypoints.has(checkpoint.waypoint)) {
      diagnostics.push(
        authoring_diagnostic({
          code: "ORPHAN_CHECKPOINT",
          severity: "error",
          message:
            `Checkpoint ${checkpoint.id} references missing waypoint ${checkpoint.waypoint}.`,
          subject: checkpoint.id,
        }),
      );
    }
  }
  const orders = [...project.checkpoints].sort((left, right) =>
    left.order - right.order
  ).map(({ order }) => order);
  if (orders.some((order, index) => order !== index)) {
    diagnostics.push(authoring_diagnostic({
      code: "CHECKPOINT_ORDER_GAP",
      severity: "error",
      message:
        `${project.title} checkpoint order must be contiguous from zero.`,
      recovery: "Reorder checkpoints in the course inspector.",
    }));
  }
  return Object.freeze(diagnostics);
}
