import {
  agent_profile_id,
  type AgentProfileId,
  navigation_area_id,
  type NavigationAreaId,
} from "./identity.ts";

declare const agent_profile_brand: unique symbol;

export interface NavigationArea {
  readonly id: NavigationAreaId;
  readonly default_cost: number;
}

export interface AgentProfile {
  readonly id: AgentProfileId;
  readonly radius: number;
  readonly height: number;
  readonly maximum_climb: number;
  readonly maximum_slope_degrees: number;
  readonly maximum_speed: number;
  readonly maximum_acceleration: number;
  readonly area_costs: ReadonlyMap<NavigationAreaId, number>;
  readonly [agent_profile_brand]: true;
}

export interface AgentProfileSource {
  readonly id: AgentProfileId;
  readonly radius: number;
  readonly height: number;
  readonly maximum_climb: number;
  readonly maximum_slope_degrees: number;
  readonly maximum_speed: number;
  readonly maximum_acceleration: number;
  readonly area_costs: ReadonlyMap<NavigationAreaId, number>;
}

export type AgentProfileResult =
  | { readonly type: "ready"; readonly profile: AgentProfile }
  | { readonly type: "invalid_profile"; readonly reason: string };

export function create_agent_profile(
  source: AgentProfileSource,
): AgentProfileResult {
  let id: AgentProfileId;
  try {
    id = agent_profile_id(source.id);
    if (id !== source.id) {
      throw new Error(
        `navigation agent profile id ${
          JSON.stringify(source.id)
        } is not canonical`,
      );
    }
  } catch (error) {
    return {
      type: "invalid_profile",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const values = [
    ["radius", source.radius, false],
    ["height", source.height, true],
    ["maximum climb", source.maximum_climb, false],
    ["maximum speed", source.maximum_speed, true],
    ["maximum acceleration", source.maximum_acceleration, true],
  ] as const;
  for (const [label, value, positive] of values) {
    if (!Number.isFinite(value) || value < 0 || (positive && value === 0)) {
      return {
        type: "invalid_profile",
        reason: `agent profile ${JSON.stringify(source.id)} ${label} ${
          JSON.stringify(value)
        } must be ${positive ? "positive" : "nonnegative"} and finite`,
      };
    }
  }
  if (
    !Number.isFinite(source.maximum_slope_degrees) ||
    source.maximum_slope_degrees < 0 || source.maximum_slope_degrees >= 90
  ) {
    return {
      type: "invalid_profile",
      reason: `agent profile ${JSON.stringify(source.id)} maximum slope ${
        JSON.stringify(source.maximum_slope_degrees)
      } must be finite and in 0..<90 degrees`,
    };
  }
  const costs: [NavigationAreaId, number][] = [];
  for (const [area, cost] of source.area_costs) {
    try {
      const parsed_area = navigation_area_id(area);
      if (parsed_area !== area) {
        throw new Error(
          `navigation area id ${JSON.stringify(area)} is not canonical`,
        );
      }
      costs.push([parsed_area, cost]);
    } catch (error) {
      return {
        type: "invalid_profile",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!Number.isFinite(cost) || cost <= 0) {
      return {
        type: "invalid_profile",
        reason: `agent profile ${JSON.stringify(source.id)} area ${
          JSON.stringify(area)
        } cost ${JSON.stringify(cost)} must be positive and finite`,
      };
    }
  }
  costs.sort(([left], [right]) => left.localeCompare(right));
  return {
    type: "ready",
    profile: Object.freeze({
      ...source,
      id,
      area_costs: new Map(costs),
    }) as unknown as AgentProfile,
  };
}

export function area_cost(profile: AgentProfile, area: NavigationArea): number {
  if (navigation_area_id(area.id) !== area.id) {
    throw new Error(
      `navigation area id ${JSON.stringify(area.id)} is not canonical`,
    );
  }
  if (!Number.isFinite(area.default_cost) || area.default_cost <= 0) {
    throw new Error(
      `navigation area ${JSON.stringify(area.id)} default cost ${
        JSON.stringify(area.default_cost)
      } must be positive and finite`,
    );
  }
  return profile.area_costs.get(area.id) ?? area.default_cost;
}
