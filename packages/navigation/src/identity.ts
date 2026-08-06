declare const tile_id_brand: unique symbol;
declare const polygon_id_brand: unique symbol;
declare const area_id_brand: unique symbol;
declare const profile_id_brand: unique symbol;
declare const link_id_brand: unique symbol;
declare const obstacle_id_brand: unique symbol;
declare const agent_id_brand: unique symbol;

export type NavigationTileId = string & { readonly [tile_id_brand]: true };
export type NavigationPolygonId = string & {
  readonly [polygon_id_brand]: true;
};
export type NavigationAreaId = string & { readonly [area_id_brand]: true };
export type AgentProfileId = string & { readonly [profile_id_brand]: true };
export type OffMeshLinkId = string & { readonly [link_id_brand]: true };
export type NavigationObstacleId = string & {
  readonly [obstacle_id_brand]: true;
};
export type NavigationAgentId = string & { readonly [agent_id_brand]: true };

export function navigation_tile_id(value: string): NavigationTileId {
  return identity(value, "navigation tile id") as NavigationTileId;
}

export function navigation_polygon_id(value: string): NavigationPolygonId {
  return identity(value, "navigation polygon id") as NavigationPolygonId;
}

export function navigation_area_id(value: string): NavigationAreaId {
  return identity(value, "navigation area id") as NavigationAreaId;
}

export function agent_profile_id(value: string): AgentProfileId {
  return identity(value, "navigation agent profile id") as AgentProfileId;
}

export function off_mesh_link_id(value: string): OffMeshLinkId {
  return identity(value, "navigation off-mesh link id") as OffMeshLinkId;
}

export function navigation_obstacle_id(value: string): NavigationObstacleId {
  return identity(value, "navigation obstacle id") as NavigationObstacleId;
}

export function navigation_agent_id(value: string): NavigationAgentId {
  return identity(value, "navigation agent id") as NavigationAgentId;
}

function identity(value: string, label: string): string {
  const parsed = value.trim();
  if (parsed.length === 0) {
    throw new Error(`${label} ${JSON.stringify(value)} cannot be empty`);
  }
  return parsed;
}
