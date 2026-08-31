export type StrategyProjectId = string & {
  readonly __brand: "StrategyProjectId";
};
export type StrategyFactionId = string & {
  readonly __brand: "StrategyFactionId";
};
export type StrategyStructureId = string & {
  readonly __brand: "StrategyStructureId";
};
export type StrategyRouteId = string & {
  readonly __brand: "StrategyRouteId";
};
export type StrategyWaveId = string & {
  readonly __brand: "StrategyWaveId";
};
export type StrategyObjectiveId = string & {
  readonly __brand: "StrategyObjectiveId";
};
export type StrategyResourceId = string & {
  readonly __brand: "StrategyResourceId";
};
export type StrategyUnitId = string & {
  readonly __brand: "StrategyUnitId";
};

export const strategy_project_id = identity<StrategyProjectId>("project");
export const strategy_faction_id = identity<StrategyFactionId>("faction");
export const strategy_structure_id = identity<StrategyStructureId>(
  "structure",
);
export const strategy_route_id = identity<StrategyRouteId>("route");
export const strategy_wave_id = identity<StrategyWaveId>("wave");
export const strategy_objective_id = identity<StrategyObjectiveId>(
  "objective",
);
export const strategy_resource_id = identity<StrategyResourceId>("resource");
export const strategy_unit_id = identity<StrategyUnitId>("unit");

function identity<Identity extends string>(label: string) {
  return (source: string): Identity => {
    const value = source.trim();
    if (!/^[a-z][a-z0-9-]*$/.test(value)) {
      throw new Error(
        `strategy ${label} identity ${
          JSON.stringify(source)
        } must use lowercase kebab-case`,
      );
    }
    return value as Identity;
  };
}
