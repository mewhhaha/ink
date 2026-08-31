import type { StrategyResourceId } from "./identity.ts";
import {
  strategy_project,
  type StrategyMap,
  type StrategyObjective,
  type StrategyProject,
  type StrategyRoute,
  type StrategyStructure,
  type StrategyWave,
} from "./model.ts";

export type StrategyCommand =
  | { readonly type: "paint_map"; readonly map: StrategyMap }
  | {
    readonly type: "place_structure";
    readonly structure: StrategyStructure;
  }
  | { readonly type: "draw_route"; readonly route: StrategyRoute }
  | { readonly type: "schedule_wave"; readonly wave: StrategyWave }
  | {
    readonly type: "edit_economy";
    readonly resources: readonly StrategyResourceId[];
  }
  | { readonly type: "set_objective"; readonly objective: StrategyObjective };

export function apply_strategy_command(
  project: StrategyProject,
  command: StrategyCommand,
): StrategyProject {
  switch (command.type) {
    case "paint_map":
      require_map_contains_project(project, command.map);
      return strategy_project({ ...project, map: command.map });
    case "place_structure":
      require_unique(project.structures, command.structure.id, "structure");
      require_point(
        project.map,
        command.structure.position,
        command.structure.id,
      );
      require_faction(
        project,
        command.structure.faction_id,
        command.structure.id,
      );
      return strategy_project({
        ...project,
        structures: [...project.structures, command.structure],
      });
    case "draw_route":
      require_unique(project.routes, command.route.id, "route");
      for (const point of command.route.points) {
        require_point(project.map, point, command.route.id);
      }
      return strategy_project({
        ...project,
        routes: [...project.routes, command.route],
      });
    case "schedule_wave":
      require_unique(project.waves, command.wave.id, "wave");
      if (!project.routes.some(({ id }) => id === command.wave.route_id)) {
        throw new Error(
          `strategy wave ${command.wave.id} references missing route ${command.wave.route_id}`,
        );
      }
      require_faction(project, command.wave.faction_id, command.wave.id);
      return strategy_project({
        ...project,
        waves: [...project.waves, command.wave],
      });
    case "edit_economy":
      require_unique_identities(command.resources, "resource");
      return strategy_project({ ...project, resources: command.resources });
    case "set_objective":
      require_unique(project.objectives, command.objective.id, "objective");
      return strategy_project({
        ...project,
        objectives: [...project.objectives, command.objective],
      });
  }
  const exhaustive: never = command;
  return exhaustive;
}

function require_map_contains_project(
  project: StrategyProject,
  map: StrategyMap,
): void {
  for (const structure of project.structures) {
    require_point(map, structure.position, structure.id);
  }
  for (const route of project.routes) {
    for (const point of route.points) require_point(map, point, route.id);
  }
}

function require_faction(
  project: StrategyProject,
  faction_id: string,
  owner_id: string,
): void {
  if (!project.factions.some(({ id }) => id === faction_id)) {
    throw new Error(
      `strategy ${owner_id} references missing faction ${faction_id}`,
    );
  }
}

function require_unique(
  entries: readonly { readonly id: string }[],
  id: string,
  label: string,
): void {
  if (entries.some((entry) => entry.id === id)) {
    throw new Error(`strategy ${label} repeats identity ${id}`);
  }
}

function require_unique_identities(
  identities: readonly string[],
  label: string,
): void {
  const unique = new Set(identities);
  if (unique.size !== identities.length) {
    throw new Error(`strategy ${label} identities must be unique`);
  }
}

function require_point(
  map: StrategyMap,
  point: { readonly x: number; readonly y: number },
  owner_id: string,
): void {
  if (
    !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 ||
    point.y < 0 || point.x > map.width || point.y > map.height
  ) {
    throw new Error(
      `strategy ${owner_id} point (${point.x}, ${point.y}) lies outside ${map.width}x${map.height}`,
    );
  }
}
