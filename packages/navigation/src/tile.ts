import { mesh_topology, type MeshTopology } from "@ink/geometry/mesh.ts";
import type { Aabb } from "@ink/geometry/shapes.ts";
import { aabb } from "@ink/geometry/shapes.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import {
  vec3,
  vec3_cross,
  vec3_length,
  vec3_scale,
  vec3_subtract,
} from "@ink/math/vector.ts";
import type { Observer } from "@ink/observability/observer.ts";
import type { ChunkCoordinate } from "@ink/world/identity.ts";
import { chunk_coordinate } from "@ink/world/identity.ts";
import {
  navigation_area_id,
  navigation_obstacle_id,
  navigation_polygon_id,
  navigation_tile_id,
  type NavigationAreaId,
  type NavigationObstacleId,
  type NavigationPolygonId,
  type NavigationTileId,
  off_mesh_link_id,
  type OffMeshLinkId,
} from "./identity.ts";
import type { AgentProfile } from "./profile.ts";

export interface NavigationObstacle {
  readonly id: NavigationObstacleId;
  readonly revision: number;
  readonly bounds: Aabb;
}

export interface OffMeshLink {
  readonly id: OffMeshLinkId;
  readonly start: Vec3;
  readonly finish: Vec3;
  readonly cost: number;
  readonly direction: "one_way" | "bidirectional";
  readonly area: NavigationAreaId;
  readonly enabled: boolean;
}

export interface NavigationPortal {
  readonly to: NavigationPolygonId;
  readonly left: Vec3;
  readonly right: Vec3;
}

export interface NavigationPolygon {
  readonly id: NavigationPolygonId;
  readonly tile_id: NavigationTileId;
  readonly region: number;
  readonly area: NavigationAreaId;
  readonly vertices: readonly Vec3[];
  readonly center: Vec3;
  readonly portals: readonly NavigationPortal[];
}

export interface NavigationContourSegment {
  readonly start: Vec3;
  readonly finish: Vec3;
}

export interface NavigationContour {
  readonly region: number;
  readonly segments: readonly NavigationContourSegment[];
}

export interface NavigationDetailSurface {
  readonly polygon: NavigationPolygonId;
  readonly triangles: readonly (readonly [Vec3, Vec3, Vec3])[];
}

export interface NavigationTileDiagnostics {
  readonly voxel_samples: number;
  readonly slope_rejected: number;
  readonly obstacle_rejected: number;
  readonly clearance_rejected: number;
  readonly regions: number;
  readonly polygons: number;
}

export interface NavigationTile {
  readonly id: NavigationTileId;
  readonly coordinate: ChunkCoordinate;
  readonly source_revision: number;
  readonly profile: AgentProfile["id"];
  readonly bounds: Aabb;
  readonly cell_size: number;
  readonly cell_height: number;
  readonly maximum_climb: number;
  readonly width: number;
  readonly depth: number;
  readonly polygons: readonly NavigationPolygon[];
  readonly contours: readonly NavigationContour[];
  readonly details: readonly NavigationDetailSurface[];
  readonly links: readonly OffMeshLink[];
  readonly distance_field: readonly number[];
  readonly diagnostics: NavigationTileDiagnostics;
}

export interface NavigationTileInput {
  readonly id: NavigationTileId;
  readonly coordinate: ChunkCoordinate;
  readonly source_revision: number;
  readonly origin: Vec3;
  readonly width: number;
  readonly depth: number;
  readonly cell_size: number;
  readonly cell_height: number;
  readonly geometry: readonly MeshTopology[];
  readonly default_area: NavigationAreaId;
  readonly areas?: readonly NavigationAreaId[];
  readonly links?: readonly OffMeshLink[];
  readonly obstacles?: readonly NavigationObstacle[];
}

export interface NavigationGridTileSource {
  readonly id: NavigationTileId;
  readonly coordinate_x: number;
  readonly coordinate_z: number;
  readonly coordinate_lod?: number;
  readonly source_revision: number;
  readonly origin: Vec3;
  readonly width: number;
  readonly depth: number;
  readonly cell_size: number;
  readonly cell_height: number;
  readonly default_area: NavigationAreaId;
  readonly areas?: readonly NavigationAreaId[];
  readonly links?: readonly OffMeshLink[];
  readonly obstacles?: readonly NavigationObstacle[];
}

export interface NavigationObstacleSource {
  readonly id: NavigationObstacleId;
  readonly revision: number;
  readonly minimum: Vec3;
  readonly maximum: Vec3;
}

export type NavigationTileBuildResult =
  | { readonly type: "ready"; readonly tile: NavigationTile }
  | {
    readonly type: "malformed_geometry";
    readonly tile_id: NavigationTileId;
    readonly reason: string;
  }
  | { readonly type: "cancelled"; readonly tile_id: NavigationTileId };

interface SurfaceCell {
  height: number;
  area: NavigationAreaId;
  walkable: boolean;
  region: number;
}

interface VoxelSample {
  readonly height: number;
  readonly slope_degrees: number;
}

export function navigation_grid_tile_input(
  source: NavigationGridTileSource,
): NavigationTileInput {
  if (
    !Number.isSafeInteger(source.width) || source.width <= 0 ||
    !Number.isSafeInteger(source.depth) || source.depth <= 0
  ) {
    throw new Error(
      `navigation grid dimensions ${source.width}x${source.depth} must be positive safe integers`,
    );
  }
  const vertex_count = (source.width + 1) * (source.depth + 1);
  if (!Number.isSafeInteger(vertex_count)) {
    throw new Error(
      `navigation grid dimensions ${source.width}x${source.depth} exceed a safe vertex count`,
    );
  }
  const positions = Array.from({ length: vertex_count }, (_, index) => {
    const column = index % (source.width + 1);
    const row = Math.floor(index / (source.width + 1));
    return vec3(
      source.origin.x + column * source.cell_size,
      source.origin.y,
      source.origin.z + row * source.cell_size,
    );
  });
  const indices: number[] = [];
  for (let row = 0; row < source.depth; row += 1) {
    for (let column = 0; column < source.width; column += 1) {
      const north_west = row * (source.width + 1) + column;
      const north_east = north_west + 1;
      const south_west = north_west + source.width + 1;
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
  return Object.freeze({
    id: source.id,
    coordinate: chunk_coordinate(
      source.coordinate_x,
      source.coordinate_z,
      source.coordinate_lod,
    ),
    source_revision: source.source_revision,
    origin: vec3(source.origin.x, source.origin.y, source.origin.z),
    width: source.width,
    depth: source.depth,
    cell_size: source.cell_size,
    cell_height: source.cell_height,
    geometry: Object.freeze([mesh_topology(positions, indices)]),
    default_area: source.default_area,
    ...(source.areas === undefined
      ? {}
      : { areas: Object.freeze([...source.areas]) }),
    ...(source.links === undefined
      ? {}
      : { links: Object.freeze([...source.links]) }),
    ...(source.obstacles === undefined
      ? {}
      : { obstacles: Object.freeze([...source.obstacles]) }),
  });
}

export function navigation_obstacle(
  source: NavigationObstacleSource,
): NavigationObstacle {
  return Object.freeze({
    id: navigation_obstacle_id(source.id),
    revision: source.revision,
    bounds: aabb(source.minimum, source.maximum),
  });
}

export function build_navigation_tile(
  input: NavigationTileInput,
  profile: AgentProfile,
  options: { readonly signal?: AbortSignal; readonly observer?: Observer } = {},
): NavigationTileBuildResult {
  const span = options.observer?.start_span("navigation.tile.bake", {
    tile_id: input.id,
    source_revision: input.source_revision,
  });
  try {
    if (options.signal?.aborted) {
      span?.end({ status: "cancelled" });
      return { type: "cancelled", tile_id: input.id };
    }
    validate_input(input);
    const samples = voxelize(input);
    const sample_count = samples.reduce(
      (total, cell) => total + cell.length,
      0,
    );
    options.observer?.event("navigation.tile.voxelized", {
      tile_id: input.id,
      samples: sample_count,
    });
    const filtered = filter_walkable(input, profile, samples);
    options.observer?.event("navigation.tile.filtered", {
      tile_id: input.id,
      slope_rejected: filtered.slope_rejected,
      obstacle_rejected: filtered.obstacle_rejected,
    });
    const distance_field = build_distance_field(
      filtered.cells,
      input.width,
      input.depth,
    );
    const clearance_rejected = apply_clearance(
      filtered.cells,
      distance_field,
      input,
      profile,
    );
    options.observer?.event("navigation.tile.distance_field", {
      tile_id: input.id,
      clearance_rejected,
    });
    const regions = construct_regions(filtered.cells, input, profile);
    const contours = construct_contours(filtered.cells, input);
    options.observer?.event("navigation.tile.regions", {
      tile_id: input.id,
      regions,
      contour_segments: contours.reduce(
        (total, contour) => total + contour.segments.length,
        0,
      ),
    });
    const polygons = polygonize(filtered.cells, input, profile);
    const details = detail_surfaces(polygons);
    const bounds = tile_bounds(input, filtered.cells);
    const diagnostics = Object.freeze({
      voxel_samples: sample_count,
      slope_rejected: filtered.slope_rejected,
      obstacle_rejected: filtered.obstacle_rejected,
      clearance_rejected,
      regions,
      polygons: polygons.length,
    });
    const tile = Object.freeze({
      id: input.id,
      coordinate: input.coordinate,
      source_revision: input.source_revision,
      profile: profile.id,
      bounds,
      cell_size: input.cell_size,
      cell_height: input.cell_height,
      maximum_climb: profile.maximum_climb,
      width: input.width,
      depth: input.depth,
      polygons,
      contours,
      details,
      links: parse_links(input.links ?? []),
      distance_field: Object.freeze(distance_field),
      diagnostics,
    });
    span?.end({
      status: "ready",
      polygons: polygons.length,
      regions,
    });
    return { type: "ready", tile };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    span?.end({ status: "malformed_geometry" });
    options.observer?.diagnostic(
      "error",
      "navigation.tile.bake",
      reason,
      { tile_id: input.id },
    );
    return { type: "malformed_geometry", tile_id: input.id, reason };
  }
}

function validate_input(input: NavigationTileInput): void {
  if (navigation_tile_id(input.id) !== input.id) {
    throw new Error(
      `navigation tile id ${JSON.stringify(input.id)} is not canonical`,
    );
  }
  chunk_coordinate(
    input.coordinate.x,
    input.coordinate.z,
    input.coordinate.lod,
  );
  if (navigation_area_id(input.default_area) !== input.default_area) {
    throw new Error(
      `navigation area id ${
        JSON.stringify(input.default_area)
      } is not canonical`,
    );
  }
  for (
    const [label, value] of [
      ["width", input.width],
      ["depth", input.depth],
    ] as const
  ) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `navigation tile ${JSON.stringify(input.id)} ${label} ${
          JSON.stringify(value)
        } must be a positive safe integer`,
      );
    }
  }
  const cell_count = input.width * input.depth;
  if (!Number.isSafeInteger(cell_count)) {
    throw new Error(
      `navigation tile ${
        JSON.stringify(input.id)
      } dimensions ${input.width}x${input.depth} exceed a safe cell count`,
    );
  }
  for (
    const [label, value] of [
      ["cell size", input.cell_size],
      ["cell height", input.cell_height],
    ] as const
  ) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `navigation tile ${JSON.stringify(input.id)} ${label} ${
          JSON.stringify(value)
        } must be positive and finite`,
      );
    }
  }
  if (
    !Number.isSafeInteger(input.source_revision) || input.source_revision < 0
  ) {
    throw new Error(
      `navigation tile ${JSON.stringify(input.id)} source revision ${
        JSON.stringify(input.source_revision)
      } must be a nonnegative safe integer`,
    );
  }
  if (input.geometry.length === 0) {
    throw new Error(
      `navigation tile ${JSON.stringify(input.id)} has no source geometry`,
    );
  }
  if (
    input.areas !== undefined &&
    input.areas.length !== cell_count
  ) {
    throw new Error(
      `navigation tile ${
        JSON.stringify(input.id)
      } has ${input.areas.length} area cells; expected ${cell_count}`,
    );
  }
  for (const area of input.areas ?? []) {
    if (navigation_area_id(area) !== area) {
      throw new Error(
        `navigation area id ${JSON.stringify(area)} is not canonical`,
      );
    }
  }
  for (const obstacle of input.obstacles ?? []) {
    navigation_obstacle_id(obstacle.id);
    if (!Number.isSafeInteger(obstacle.revision) || obstacle.revision < 0) {
      throw new Error(
        `navigation obstacle ${JSON.stringify(obstacle.id)} revision ${
          JSON.stringify(obstacle.revision)
        } must be a nonnegative safe integer`,
      );
    }
  }
}

function voxelize(input: NavigationTileInput): VoxelSample[][] {
  const cells = Array.from(
    { length: input.width * input.depth },
    () => [] as VoxelSample[],
  );
  for (const topology of input.geometry) {
    for (let triangle = 0; triangle < topology.triangle_count; triangle += 1) {
      const offset = triangle * 3;
      const a = topology.positions[topology.indices[offset]];
      const b = topology.positions[topology.indices[offset + 1]];
      const c = topology.positions[topology.indices[offset + 2]];
      const cross = vec3_cross(vec3_subtract(b, a), vec3_subtract(c, a));
      const length = vec3_length(cross);
      if (length === 0) {
        throw new Error(
          `navigation tile ${
            JSON.stringify(input.id)
          } geometry triangle ${triangle} has zero area`,
        );
      }
      const normal = vec3_scale(cross, 1 / length);
      const denominator = (b.z - c.z) * (a.x - c.x) +
        (c.x - b.x) * (a.z - c.z);
      if (Math.abs(denominator) <= 1e-9) continue;
      const minimum_column = clamp(
        Math.floor(
          (Math.min(a.x, b.x, c.x) - input.origin.x) / input.cell_size,
        ),
        0,
        input.width - 1,
      );
      const maximum_column = clamp(
        Math.floor(
          (Math.max(a.x, b.x, c.x) - input.origin.x) / input.cell_size,
        ),
        0,
        input.width - 1,
      );
      const minimum_row = clamp(
        Math.floor(
          (Math.min(a.z, b.z, c.z) - input.origin.z) / input.cell_size,
        ),
        0,
        input.depth - 1,
      );
      const maximum_row = clamp(
        Math.floor(
          (Math.max(a.z, b.z, c.z) - input.origin.z) / input.cell_size,
        ),
        0,
        input.depth - 1,
      );
      for (let row = minimum_row; row <= maximum_row; row += 1) {
        for (
          let column = minimum_column;
          column <= maximum_column;
          column += 1
        ) {
          const x = input.origin.x + (column + 0.5) * input.cell_size;
          const z = input.origin.z + (row + 0.5) * input.cell_size;
          const barycentric = barycentric_xz(x, z, a, b, c, denominator);
          if (barycentric === undefined) continue;
          const height = barycentric.a * a.y + barycentric.b * b.y +
            barycentric.c * c.y;
          cells[row * input.width + column].push({
            height: quantize(height, input.cell_height),
            slope_degrees: Math.acos(clamp(normal.y, -1, 1)) * 180 / Math.PI,
          });
        }
      }
    }
  }
  for (const cell of cells) {
    cell.sort((left, right) =>
      left.height - right.height || left.slope_degrees - right.slope_degrees
    );
  }
  return cells;
}

function filter_walkable(
  input: NavigationTileInput,
  profile: AgentProfile,
  samples: readonly VoxelSample[][],
): {
  readonly cells: SurfaceCell[];
  readonly slope_rejected: number;
  readonly obstacle_rejected: number;
} {
  let slope_rejected = 0;
  let obstacle_rejected = 0;
  const cells = samples.map((cell_samples, index) => {
    let chosen: VoxelSample | undefined;
    for (let sample = cell_samples.length - 1; sample >= 0; sample -= 1) {
      const candidate = cell_samples[sample];
      const next = cell_samples[sample + 1];
      if (candidate.slope_degrees > profile.maximum_slope_degrees) {
        slope_rejected += 1;
        continue;
      }
      if (
        next !== undefined && next.height - candidate.height < profile.height
      ) {
        continue;
      }
      chosen = candidate;
      break;
    }
    const area = input.areas?.[index] ?? input.default_area;
    if (chosen === undefined) {
      return { height: input.origin.y, area, walkable: false, region: -1 };
    }
    const column = index % input.width;
    const row = Math.floor(index / input.width);
    const x = input.origin.x + (column + 0.5) * input.cell_size;
    const z = input.origin.z + (row + 0.5) * input.cell_size;
    const blocked = (input.obstacles ?? []).some((obstacle) =>
      x >= obstacle.bounds.minimum.x && x <= obstacle.bounds.maximum.x &&
      z >= obstacle.bounds.minimum.z && z <= obstacle.bounds.maximum.z &&
      chosen.height <= obstacle.bounds.maximum.y &&
      chosen.height + profile.height >= obstacle.bounds.minimum.y
    );
    if (blocked) obstacle_rejected += 1;
    return {
      height: chosen.height,
      area,
      walkable: !blocked,
      region: -1,
    };
  });
  return { cells, slope_rejected, obstacle_rejected };
}

function build_distance_field(
  cells: readonly SurfaceCell[],
  width: number,
  depth: number,
): number[] {
  const distances = cells.map((cell, index) => {
    if (!cell.walkable) return 0;
    const x = index % width;
    const z = Math.floor(index / width);
    return Math.min(x + 1, z + 1, width - x, depth - z);
  });
  for (let row = 0; row < depth; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const index = row * width + column;
      if (column > 0) {
        distances[index] = Math.min(distances[index], distances[index - 1] + 1);
      }
      if (row > 0) {
        distances[index] = Math.min(
          distances[index],
          distances[index - width] + 1,
        );
      }
    }
  }
  for (let row = depth - 1; row >= 0; row -= 1) {
    for (let column = width - 1; column >= 0; column -= 1) {
      const index = row * width + column;
      if (column + 1 < width) {
        distances[index] = Math.min(distances[index], distances[index + 1] + 1);
      }
      if (row + 1 < depth) {
        distances[index] = Math.min(
          distances[index],
          distances[index + width] + 1,
        );
      }
    }
  }
  return distances;
}

function apply_clearance(
  cells: SurfaceCell[],
  distances: readonly number[],
  input: NavigationTileInput,
  profile: AgentProfile,
): number {
  let rejected = 0;
  for (let index = 0; index < cells.length; index += 1) {
    if (!cells[index].walkable) continue;
    const clearance = (distances[index] - 0.5) * input.cell_size;
    if (clearance + 1e-9 >= profile.radius) continue;
    cells[index].walkable = false;
    rejected += 1;
  }
  return rejected;
}

function construct_regions(
  cells: SurfaceCell[],
  input: NavigationTileInput,
  profile: AgentProfile,
): number {
  let next_region = 0;
  for (let start = 0; start < cells.length; start += 1) {
    if (!cells[start].walkable || cells[start].region !== -1) continue;
    cells[start].region = next_region;
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.shift()!;
      for (
        const neighbor of cardinal_neighbors(current, input.width, input.depth)
      ) {
        if (!cells[neighbor].walkable || cells[neighbor].region !== -1) {
          continue;
        }
        if (
          Math.abs(cells[current].height - cells[neighbor].height) >
            profile.maximum_climb + 1e-9
        ) continue;
        cells[neighbor].region = next_region;
        pending.push(neighbor);
      }
    }
    next_region += 1;
  }
  return next_region;
}

function construct_contours(
  cells: readonly SurfaceCell[],
  input: NavigationTileInput,
): readonly NavigationContour[] {
  const segments = new Map<number, NavigationContourSegment[]>();
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (!cell.walkable) continue;
    const column = index % input.width;
    const row = Math.floor(index / input.width);
    for (const side of ["north", "east", "south", "west"] as const) {
      const neighbor = neighbor_at(column, row, side, input.width, input.depth);
      if (neighbor !== undefined && cells[neighbor].region === cell.region) {
        continue;
      }
      const [start, finish] = edge_points(
        input,
        column,
        row,
        cell.height,
        side,
      );
      const region_segments = segments.get(cell.region) ?? [];
      region_segments.push(Object.freeze({ start, finish }));
      segments.set(cell.region, region_segments);
    }
  }
  return Object.freeze(
    [...segments].sort(([left], [right]) => left - right).map(
      ([region, contour_segments]) =>
        Object.freeze({
          region,
          segments: Object.freeze(contour_segments.sort(compare_segments)),
        }),
    ),
  );
}

function polygonize(
  cells: readonly SurfaceCell[],
  input: NavigationTileInput,
  profile: AgentProfile,
): readonly NavigationPolygon[] {
  const ids = cells.map((cell, index) =>
    cell.walkable
      ? navigation_polygon_id(
        `${input.id}:${index % input.width}:${Math.floor(index / input.width)}`,
      )
      : undefined
  );
  const polygons: NavigationPolygon[] = [];
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    const id = ids[index];
    if (!cell.walkable || id === undefined) continue;
    const column = index % input.width;
    const row = Math.floor(index / input.width);
    const vertices = Object.freeze([
      point(input, column, row, cell.height),
      point(input, column, row + 1, cell.height),
      point(input, column + 1, row + 1, cell.height),
      point(input, column + 1, row, cell.height),
    ]);
    const portals: NavigationPortal[] = [];
    for (const side of ["north", "east", "south", "west"] as const) {
      const neighbor = neighbor_at(column, row, side, input.width, input.depth);
      if (neighbor === undefined || ids[neighbor] === undefined) continue;
      if (
        Math.abs(cell.height - cells[neighbor].height) >
          profile.maximum_climb + 1e-9
      ) continue;
      const [left, right] = edge_points(input, column, row, cell.height, side);
      portals.push(Object.freeze({ to: ids[neighbor], left, right }));
    }
    polygons.push(Object.freeze({
      id,
      tile_id: input.id,
      region: cell.region,
      area: cell.area,
      vertices,
      center: vec3(
        input.origin.x + (column + 0.5) * input.cell_size,
        cell.height,
        input.origin.z + (row + 0.5) * input.cell_size,
      ),
      portals: Object.freeze(
        portals.sort((left, right) => left.to.localeCompare(right.to)),
      ),
    }));
  }
  return Object.freeze(
    polygons.sort((left, right) => left.id.localeCompare(right.id)),
  );
}

function detail_surfaces(
  polygons: readonly NavigationPolygon[],
): readonly NavigationDetailSurface[] {
  return Object.freeze(polygons.map((polygon) =>
    Object.freeze({
      polygon: polygon.id,
      triangles: Object.freeze([
        Object.freeze([
          polygon.vertices[0],
          polygon.vertices[1],
          polygon.vertices[2],
        ]) as readonly [Vec3, Vec3, Vec3],
        Object.freeze([
          polygon.vertices[0],
          polygon.vertices[2],
          polygon.vertices[3],
        ]) as readonly [Vec3, Vec3, Vec3],
      ]),
    })
  ));
}

function tile_bounds(
  input: NavigationTileInput,
  cells: readonly SurfaceCell[],
): Aabb {
  const heights = cells.filter(({ walkable }) => walkable).map(({ height }) =>
    height
  );
  const minimum_y = heights.length === 0
    ? input.origin.y
    : Math.min(...heights);
  const maximum_y = heights.length === 0
    ? input.origin.y
    : Math.max(...heights) + input.cell_height;
  return aabb(
    vec3(input.origin.x, minimum_y, input.origin.z),
    vec3(
      input.origin.x + input.width * input.cell_size,
      maximum_y,
      input.origin.z + input.depth * input.cell_size,
    ),
  );
}

function parse_links(source: readonly OffMeshLink[]): readonly OffMeshLink[] {
  const identities = new Set<string>();
  for (const link of source) {
    off_mesh_link_id(link.id);
    navigation_area_id(link.area);
  }
  return Object.freeze(
    [...source].sort((left, right) => left.id.localeCompare(right.id)).map(
      (link) => {
        if (off_mesh_link_id(link.id) !== link.id) {
          throw new Error(
            `navigation off-mesh link id ${
              JSON.stringify(link.id)
            } is not canonical`,
          );
        }
        if (navigation_area_id(link.area) !== link.area) {
          throw new Error(
            `navigation area id ${JSON.stringify(link.area)} is not canonical`,
          );
        }
        if (identities.has(link.id)) {
          throw new Error(
            `navigation tile repeats off-mesh link ${JSON.stringify(link.id)}`,
          );
        }
        identities.add(link.id);
        if (!Number.isFinite(link.cost) || link.cost < 0) {
          throw new Error(
            `navigation off-mesh link ${JSON.stringify(link.id)} cost ${
              JSON.stringify(link.cost)
            } must be finite and nonnegative`,
          );
        }
        if (
          link.direction !== "one_way" && link.direction !== "bidirectional"
        ) {
          throw new Error(
            `navigation off-mesh link ${JSON.stringify(link.id)} direction ${
              JSON.stringify(link.direction)
            } is unsupported`,
          );
        }
        return Object.freeze({
          ...link,
          start: vec3(link.start.x, link.start.y, link.start.z),
          finish: vec3(link.finish.x, link.finish.y, link.finish.z),
        });
      },
    ),
  );
}

function edge_points(
  input: NavigationTileInput,
  column: number,
  row: number,
  height: number,
  side: "north" | "east" | "south" | "west",
): readonly [Vec3, Vec3] {
  const west = input.origin.x + column * input.cell_size;
  const east = west + input.cell_size;
  const north = input.origin.z + row * input.cell_size;
  const south = north + input.cell_size;
  switch (side) {
    case "north":
      return [vec3(east, height, north), vec3(west, height, north)];
    case "east":
      return [vec3(east, height, south), vec3(east, height, north)];
    case "south":
      return [vec3(west, height, south), vec3(east, height, south)];
    case "west":
      return [vec3(west, height, north), vec3(west, height, south)];
  }
}

function point(
  input: NavigationTileInput,
  column: number,
  row: number,
  height: number,
): Vec3 {
  return vec3(
    input.origin.x + column * input.cell_size,
    height,
    input.origin.z + row * input.cell_size,
  );
}

function cardinal_neighbors(
  index: number,
  width: number,
  depth: number,
): number[] {
  const column = index % width;
  const row = Math.floor(index / width);
  const neighbors: number[] = [];
  if (row > 0) neighbors.push(index - width);
  if (column + 1 < width) neighbors.push(index + 1);
  if (row + 1 < depth) neighbors.push(index + width);
  if (column > 0) neighbors.push(index - 1);
  return neighbors;
}

function neighbor_at(
  column: number,
  row: number,
  side: "north" | "east" | "south" | "west",
  width: number,
  depth: number,
): number | undefined {
  const next_column = column + (side === "east" ? 1 : side === "west" ? -1 : 0);
  const next_row = row + (side === "south" ? 1 : side === "north" ? -1 : 0);
  if (
    next_column < 0 || next_column >= width || next_row < 0 || next_row >= depth
  ) return undefined;
  return next_row * width + next_column;
}

function barycentric_xz(
  x: number,
  z: number,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  denominator: number,
): { readonly a: number; readonly b: number; readonly c: number } | undefined {
  const first = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) /
    denominator;
  const second = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) /
    denominator;
  const third = 1 - first - second;
  const epsilon = 1e-9;
  if (first < -epsilon || second < -epsilon || third < -epsilon) {
    return undefined;
  }
  return { a: first, b: second, c: third };
}

function compare_segments(
  left: NavigationContourSegment,
  right: NavigationContourSegment,
): number {
  return left.start.z - right.start.z || left.start.x - right.start.x ||
    left.finish.z - right.finish.z || left.finish.x - right.finish.x;
}

function quantize(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
