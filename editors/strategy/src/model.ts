import type { EditorPresetId } from "@ink/authoring/identity.ts";
import type {
  StrategyFactionId,
  StrategyObjectiveId,
  StrategyProjectId,
  StrategyResourceId,
  StrategyRouteId,
  StrategyStructureId,
  StrategyUnitId,
  StrategyWaveId,
} from "./identity.ts";

export interface StrategyMap {
  readonly width: number;
  readonly height: number;
}

export interface StrategyPoint {
  readonly x: number;
  readonly y: number;
}

export interface StrategyFaction {
  readonly id: StrategyFactionId;
  readonly name: string;
  readonly relation: "player" | "ally" | "opponent" | "neutral";
}

interface StrategyStructureBase {
  readonly id: StrategyStructureId;
  readonly faction_id: StrategyFactionId;
  readonly position: StrategyPoint;
}

export type StrategyStructure =
  | StrategyStructureBase & {
    readonly kind: "headquarters" | "defense" | "objective";
  }
  | StrategyStructureBase & {
    readonly kind: "barracks";
    readonly produces_unit_id: StrategyUnitId;
  };

export type StrategyRoutePoints = readonly [
  StrategyPoint,
  StrategyPoint,
  ...StrategyPoint[],
];

export interface StrategyRoute {
  readonly id: StrategyRouteId;
  readonly points: StrategyRoutePoints;
}

export interface StrategyWave {
  readonly id: StrategyWaveId;
  readonly route_id: StrategyRouteId;
  readonly faction_id: StrategyFactionId;
  readonly unit_id: StrategyUnitId;
  readonly count: number;
  readonly starts_at_seconds: number;
}

export type StrategyObjectiveCondition =
  | { readonly type: "survive_waves" }
  | {
    readonly type: "destroy_structure" | "capture_structure";
    readonly structure_id: StrategyStructureId;
  }
  | {
    readonly type: "produce_units";
    readonly unit_id: StrategyUnitId;
    readonly count: number;
  };

export interface StrategyObjective {
  readonly id: StrategyObjectiveId;
  readonly text: string;
  readonly condition: StrategyObjectiveCondition;
}

export interface StrategyProject {
  readonly schema_version: 1;
  readonly id: StrategyProjectId;
  readonly name: string;
  readonly preset_id: EditorPresetId;
  readonly map: StrategyMap;
  readonly resources: readonly StrategyResourceId[];
  readonly factions: readonly StrategyFaction[];
  readonly structures: readonly StrategyStructure[];
  readonly routes: readonly StrategyRoute[];
  readonly waves: readonly StrategyWave[];
  readonly objectives: readonly StrategyObjective[];
}

export function strategy_project(project: StrategyProject): StrategyProject {
  return Object.freeze({
    schema_version: 1,
    id: project.id,
    name: required_text(project.name, `strategy project ${project.id} name`),
    preset_id: project.preset_id,
    map: freeze_map(project.map),
    resources: Object.freeze([...project.resources]),
    factions: Object.freeze(project.factions.map((faction) =>
      Object.freeze({
        id: faction.id,
        name: required_text(
          faction.name,
          `strategy faction ${faction.id} name`,
        ),
        relation: faction.relation,
      })
    )),
    structures: Object.freeze(project.structures.map(freeze_structure)),
    routes: Object.freeze(project.routes.map(freeze_route)),
    waves: Object.freeze(project.waves.map((wave) =>
      Object.freeze({
        id: wave.id,
        route_id: wave.route_id,
        faction_id: wave.faction_id,
        unit_id: wave.unit_id,
        count: positive_integer(wave.count, `strategy wave ${wave.id} count`),
        starts_at_seconds: nonnegative_number(
          wave.starts_at_seconds,
          `strategy wave ${wave.id} start`,
        ),
      })
    )),
    objectives: Object.freeze(
      project.objectives.map((objective) =>
        Object.freeze({
          id: objective.id,
          text: required_text(
            objective.text,
            `strategy objective ${objective.id} text`,
          ),
          condition: freeze_objective_condition(objective),
        })
      ),
    ),
  });
}

function freeze_route(route: StrategyRoute): StrategyRoute {
  const points: StrategyRoutePoints = [
    freeze_point(route.points[0], `strategy route ${route.id} point 0`),
    freeze_point(route.points[1], `strategy route ${route.id} point 1`),
    ...route.points.slice(2).map((point, index) =>
      freeze_point(point, `strategy route ${route.id} point ${index + 2}`)
    ),
  ];
  return Object.freeze({
    id: route.id,
    points: Object.freeze(points),
  });
}

function freeze_structure(structure: StrategyStructure): StrategyStructure {
  const common = {
    id: structure.id,
    faction_id: structure.faction_id,
    position: freeze_point(
      structure.position,
      `strategy structure ${structure.id} position`,
    ),
  };
  switch (structure.kind) {
    case "headquarters":
    case "defense":
    case "objective":
      return Object.freeze({ ...common, kind: structure.kind });
    case "barracks":
      return Object.freeze({
        ...common,
        kind: structure.kind,
        produces_unit_id: structure.produces_unit_id,
      });
  }
  const exhaustive: never = structure;
  return exhaustive;
}

function freeze_objective_condition(
  objective: StrategyObjective,
): StrategyObjectiveCondition {
  const condition = objective.condition;
  switch (condition.type) {
    case "survive_waves":
      return Object.freeze({ type: condition.type });
    case "destroy_structure":
    case "capture_structure":
      return Object.freeze({
        type: condition.type,
        structure_id: condition.structure_id,
      });
    case "produce_units":
      return Object.freeze({
        type: condition.type,
        unit_id: condition.unit_id,
        count: positive_integer(
          condition.count,
          `strategy objective ${objective.id} unit count`,
        ),
      });
  }
  const exhaustive: never = condition;
  return exhaustive;
}

function freeze_map(map: StrategyMap): StrategyMap {
  return Object.freeze({
    width: positive_integer(map.width, "strategy map width"),
    height: positive_integer(map.height, "strategy map height"),
  });
}

function freeze_point(point: StrategyPoint, label: string): StrategyPoint {
  return Object.freeze({
    x: finite_number(point.x, `${label} x`),
    y: finite_number(point.y, `${label} y`),
  });
}

function required_text(value: string, label: string): string {
  const text = value.trim();
  if (text.length === 0) throw new Error(`${label} must not be empty`);
  return text;
}

function finite_number(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} ${String(value)} must be finite`);
  }
  return value;
}

function positive_integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} ${String(value)} must be a positive integer`);
  }
  return value;
}

function nonnegative_number(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} ${String(value)} must be nonnegative`);
  }
  return value;
}
