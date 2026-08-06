import type {
  StrategyProject,
  StrategyRoute,
  StrategyStructure,
  StrategyWave,
} from "./model.ts";

export function place_strategy_structure(
  project: StrategyProject,
  structure: StrategyStructure,
): StrategyProject {
  require_unique(project.structures, structure.id, "strategy structure");
  require_point(
    project,
    structure.position.x,
    structure.position.y,
    structure.id,
  );
  if (!project.factions.some(({ id }) => id === structure.faction)) {
    throw new Error(
      `strategy structure ${structure.id} references missing faction ${structure.faction}`,
    );
  }
  return Object.freeze({
    ...project,
    structures: Object.freeze([
      ...project.structures,
      Object.freeze(structure),
    ]),
  });
}

export function draw_strategy_route(
  project: StrategyProject,
  route: StrategyRoute,
): StrategyProject {
  require_unique(project.routes, route.id, "strategy route");
  if (route.points.length < 2) {
    throw new Error(`strategy route ${route.id} needs at least two points`);
  }
  for (const point of route.points) {
    require_point(project, point.x, point.y, route.id);
  }
  return Object.freeze({
    ...project,
    routes: Object.freeze([
      ...project.routes,
      Object.freeze({ ...route, points: Object.freeze([...route.points]) }),
    ]),
  });
}

export function schedule_strategy_wave(
  project: StrategyProject,
  wave: StrategyWave,
): StrategyProject {
  require_unique(project.waves, wave.id, "strategy wave");
  if (!project.routes.some(({ id }) => id === wave.route)) {
    throw new Error(
      `strategy wave ${wave.id} references missing route ${wave.route}`,
    );
  }
  if (!Number.isSafeInteger(wave.count) || wave.count <= 0) {
    throw new Error(
      `strategy wave ${wave.id} count ${wave.count} must be positive`,
    );
  }
  return Object.freeze({
    ...project,
    waves: Object.freeze([...project.waves, Object.freeze(wave)]),
  });
}

function require_unique(
  records: readonly { readonly id: string }[],
  id: string,
  label: string,
): void {
  if (records.some((record) => record.id === id)) {
    throw new Error(`${label} repeats ${id}`);
  }
}

function require_point(
  project: StrategyProject,
  x: number,
  y: number,
  owner: string,
): void {
  if (
    !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 ||
    x > project.width || y > project.height
  ) {
    throw new Error(
      `strategy ${owner} point (${x}, ${y}) lies outside ${project.width}x${project.height}`,
    );
  }
}
