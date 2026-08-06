import type { AgentProfileId, NavigationAreaId } from "./identity.ts";

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
  const costs = [...source.area_costs].sort(([left], [right]) =>
    left.localeCompare(right)
  );
  for (const [area, cost] of costs) {
    if (!Number.isFinite(cost) || cost <= 0) {
      return {
        type: "invalid_profile",
        reason: `agent profile ${JSON.stringify(source.id)} area ${
          JSON.stringify(area)
        } cost ${JSON.stringify(cost)} must be positive and finite`,
      };
    }
  }
  return {
    type: "ready",
    profile: Object.freeze({
      ...source,
      area_costs: new Map(costs),
    }) as unknown as AgentProfile,
  };
}

export function area_cost(profile: AgentProfile, area: NavigationArea): number {
  return profile.area_costs.get(area.id) ?? area.default_cost;
}
