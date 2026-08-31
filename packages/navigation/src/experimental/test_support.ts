import { mesh_topology, type MeshTopology } from "@ink/geometry/mesh.ts";
import { vec3 } from "@ink/math/vector.ts";
import { chunk_coordinate } from "@ink/world/identity.ts";
import {
  agent_profile_id,
  navigation_area_id,
  navigation_tile_id,
} from "../identity.ts";
import {
  type AgentProfile,
  create_agent_profile,
  type NavigationArea,
} from "../profile.ts";
import type { NavigationTileInput } from "../tile.ts";

export const ground_area: NavigationArea = Object.freeze({
  id: navigation_area_id("ground"),
  default_cost: 1,
});

export const water_area: NavigationArea = Object.freeze({
  id: navigation_area_id("water"),
  default_cost: 1,
});

export function navigation_profile(
  options: {
    readonly radius?: number;
    readonly maximum_climb?: number;
    readonly maximum_slope_degrees?: number;
    readonly area_costs?: ReadonlyMap<NavigationArea["id"], number>;
  } = {},
): AgentProfile {
  const result = create_agent_profile({
    id: agent_profile_id("test-agent"),
    radius: options.radius ?? 0.4,
    height: 1.8,
    maximum_climb: options.maximum_climb ?? 0.5,
    maximum_slope_degrees: options.maximum_slope_degrees ?? 45,
    maximum_speed: 4,
    maximum_acceleration: 8,
    area_costs: options.area_costs ?? new Map(),
  });
  if (result.type !== "ready") throw new Error(result.reason);
  return result.profile;
}

export function grid_geometry(
  width: number,
  depth: number,
  origin_x = 0,
  origin_z = 0,
  heights: readonly number[] = new Array((width + 1) * (depth + 1)).fill(0),
): MeshTopology {
  const positions = Array.from(
    { length: (width + 1) * (depth + 1) },
    (_, index) => {
      const column = index % (width + 1);
      const row = Math.floor(index / (width + 1));
      return vec3(origin_x + column, heights[index], origin_z + row);
    },
  );
  const indices: number[] = [];
  for (let row = 0; row < depth; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const north_west = row * (width + 1) + column;
      const north_east = north_west + 1;
      const south_west = north_west + width + 1;
      const south_east = south_west + 1;
      indices.push(
        north_west,
        south_west,
        north_east,
        north_east,
        south_west,
        south_east,
      );
    }
  }
  return mesh_topology(positions, indices);
}

export function tile_input(
  id: string,
  coordinate_x: number,
  coordinate_z: number,
  options: {
    readonly width?: number;
    readonly depth?: number;
    readonly geometry?: readonly MeshTopology[];
    readonly areas?: readonly NavigationArea["id"][];
  } = {},
): NavigationTileInput {
  const width = options.width ?? 2;
  const depth = options.depth ?? 2;
  const origin_x = coordinate_x * width;
  const origin_z = coordinate_z * depth;
  return {
    id: navigation_tile_id(id),
    coordinate: chunk_coordinate(coordinate_x, coordinate_z),
    source_revision: 1,
    origin: vec3(origin_x, 0, origin_z),
    width,
    depth,
    cell_size: 1,
    cell_height: 0.1,
    geometry: options.geometry ??
      [grid_geometry(width, depth, origin_x, origin_z)],
    default_area: ground_area.id,
    ...(options.areas === undefined ? {} : { areas: options.areas }),
  };
}
