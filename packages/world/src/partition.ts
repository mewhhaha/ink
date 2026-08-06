import type { AssetId } from "@ink/assets/identity.ts";
import type { Aabb } from "@ink/geometry/shapes.ts";
import { aabb_contains_point } from "@ink/geometry/queries.ts";
import { vec3 } from "@ink/math/vector.ts";
import type {
  CellId,
  ChunkCoordinate,
  GlobalPosition,
  LevelId,
  WorldId,
} from "./identity.ts";
import {
  cell_id,
  chunk_coordinate,
  global_distance_squared,
  global_position,
  positive_finite,
} from "./identity.ts";

export interface CellPortal {
  readonly id: string;
  readonly from: CellId;
  readonly to: CellId;
}

export interface PartitionCell {
  readonly id: CellId;
  readonly coordinate?: ChunkCoordinate;
  readonly bounds?: Aabb;
  readonly scene_asset: AssetId<"scene">;
  readonly dependencies: readonly AssetId[];
  readonly estimated_bytes: number;
  readonly portals: readonly CellPortal[];
}

export interface WorldPartition {
  readonly type: "grid" | "authored";
  readonly world_id: WorldId;
  readonly level_id: LevelId;
  readonly cell_size: number;
  cells(): readonly PartitionCell[];
  cell(id: CellId): PartitionCell | undefined;
  locate(position: GlobalPosition): readonly PartitionCell[];
  distance_squared(cell: PartitionCell, position: GlobalPosition): number;
  connected(id: CellId): readonly CellId[];
}

export interface GridCellSource {
  readonly coordinate: ChunkCoordinate;
  readonly scene_asset: AssetId<"scene">;
  readonly dependencies?: readonly AssetId[];
  readonly estimated_bytes: number;
  readonly portals?: readonly { readonly id: string; readonly to: CellId }[];
}

export interface GridPartitionOptions {
  readonly world_id: WorldId;
  readonly level_id: LevelId;
  readonly cell_size: number;
  readonly cells: readonly GridCellSource[];
}

export interface AuthoredCellSource {
  readonly id: CellId;
  readonly bounds: Aabb;
  readonly scene_asset: AssetId<"scene">;
  readonly dependencies?: readonly AssetId[];
  readonly estimated_bytes: number;
  readonly portals?: readonly { readonly id: string; readonly to: CellId }[];
}

export interface AuthoredPartitionOptions {
  readonly world_id: WorldId;
  readonly level_id: LevelId;
  readonly coordinate_cell_size: number;
  readonly cells: readonly AuthoredCellSource[];
}

export function create_grid_partition(
  options: GridPartitionOptions,
): WorldPartition {
  const size = positive_finite(options.cell_size, "grid partition cell size");
  const cells = options.cells.map((source) => {
    const coordinate = chunk_coordinate(
      source.coordinate.x,
      source.coordinate.z,
      source.coordinate.lod,
    );
    return Object.freeze({
      id: cell_id(
        `${options.level_id}:${coordinate.x}:${coordinate.z}:${coordinate.lod}`,
      ),
      coordinate,
      scene_asset: source.scene_asset,
      dependencies: parse_dependencies(source.dependencies ?? []),
      estimated_bytes: parse_estimated_bytes(source.estimated_bytes),
      portals: parse_portals(
        cell_id(
          `${options.level_id}:${coordinate.x}:${coordinate.z}:${coordinate.lod}`,
        ),
        source.portals ?? [],
      ),
    });
  });
  return partition("grid", options.world_id, options.level_id, size, cells);
}

export function create_authored_partition(
  options: AuthoredPartitionOptions,
): WorldPartition {
  const size = positive_finite(
    options.coordinate_cell_size,
    "authored partition coordinate cell size",
  );
  const cells = options.cells.map((source) =>
    Object.freeze({
      id: source.id,
      bounds: source.bounds,
      scene_asset: source.scene_asset,
      dependencies: parse_dependencies(source.dependencies ?? []),
      estimated_bytes: parse_estimated_bytes(source.estimated_bytes),
      portals: parse_portals(source.id, source.portals ?? []),
    })
  );
  return partition("authored", options.world_id, options.level_id, size, cells);
}

function partition(
  type: WorldPartition["type"],
  world: WorldId,
  level: LevelId,
  cell_size: number,
  source_cells: readonly PartitionCell[],
): WorldPartition {
  const by_id = new Map<CellId, PartitionCell>();
  const coordinates = new Set<string>();
  for (const cell of source_cells) {
    if (by_id.has(cell.id)) {
      throw new Error(
        `world ${JSON.stringify(world)} level ${
          JSON.stringify(level)
        } repeats cell ${JSON.stringify(cell.id)}`,
      );
    }
    if (cell.coordinate !== undefined) {
      const key =
        `${cell.coordinate.x}:${cell.coordinate.z}:${cell.coordinate.lod}`;
      if (coordinates.has(key)) {
        throw new Error(
          `world ${JSON.stringify(world)} level ${
            JSON.stringify(level)
          } repeats chunk coordinate ${key}`,
        );
      }
      coordinates.add(key);
    }
    by_id.set(cell.id, cell);
  }
  for (const cell of source_cells) {
    for (const portal of cell.portals) {
      if (!by_id.has(portal.to)) {
        throw new Error(
          `world ${JSON.stringify(world)} cell ${
            JSON.stringify(cell.id)
          } portal ${JSON.stringify(portal.id)} targets missing cell ${
            JSON.stringify(portal.to)
          }`,
        );
      }
    }
  }
  const ordered = Object.freeze(
    [...by_id.values()].sort((left, right) => left.id.localeCompare(right.id)),
  );
  return Object.freeze({
    type,
    world_id: world,
    level_id: level,
    cell_size,
    cells: () => ordered,
    cell: (id: CellId) => by_id.get(id),
    locate: (position: GlobalPosition) =>
      ordered.filter((cell) => {
        if (cell.coordinate !== undefined) {
          return cell.coordinate.x === position.cell_x &&
            cell.coordinate.z === position.cell_z;
        }
        return cell.bounds !== undefined &&
          aabb_contains_point(
              cell.bounds,
              global_to_partition_point(position, cell_size),
            ) !==
            "outside";
      }),
    distance_squared: (cell: PartitionCell, position: GlobalPosition) => {
      if (cell.coordinate !== undefined) {
        return global_distance_squared(
          global_position(
            cell.coordinate.x,
            cell.coordinate.z,
            vec3(cell_size / 2, position.offset.y, cell_size / 2),
            cell_size,
          ),
          position,
          cell_size,
        );
      }
      const point = global_to_partition_point(position, cell_size);
      const bounds = cell.bounds!;
      const x = Math.max(bounds.minimum.x, Math.min(bounds.maximum.x, point.x));
      const y = Math.max(bounds.minimum.y, Math.min(bounds.maximum.y, point.y));
      const z = Math.max(bounds.minimum.z, Math.min(bounds.maximum.z, point.z));
      return (point.x - x) ** 2 + (point.y - y) ** 2 + (point.z - z) ** 2;
    },
    connected: (id: CellId) =>
      Object.freeze(
        (by_id.get(id)?.portals ?? []).map(({ to }) => to).sort((left, right) =>
          left.localeCompare(right)
        ),
      ),
  });
}

function global_to_partition_point(
  position: GlobalPosition,
  cell_size: number,
) {
  return vec3(
    position.cell_x * cell_size + position.offset.x,
    position.offset.y,
    position.cell_z * cell_size + position.offset.z,
  );
}

function parse_dependencies(
  dependencies: readonly AssetId[],
): readonly AssetId[] {
  const ordered = [...dependencies].sort((left, right) =>
    left.localeCompare(right)
  );
  if (new Set(ordered).size !== ordered.length) {
    throw new Error(
      `cell dependencies repeat an asset ${JSON.stringify(ordered)}`,
    );
  }
  return Object.freeze(ordered);
}

function parse_estimated_bytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `cell estimated bytes ${
        JSON.stringify(value)
      } must be a nonnegative safe integer`,
    );
  }
  return value;
}

function parse_portal_id(value: string): string {
  const parsed = value.trim();
  if (parsed.length === 0) throw new Error("cell portal id cannot be empty");
  return parsed;
}

function parse_portals(
  from: CellId,
  source: readonly { readonly id: string; readonly to: CellId }[],
): readonly CellPortal[] {
  const identities = new Set<string>();
  return Object.freeze(source.map((portal) => {
    const id = parse_portal_id(portal.id);
    if (identities.has(id)) {
      throw new Error(
        `cell ${JSON.stringify(from)} repeats portal ${JSON.stringify(id)}`,
      );
    }
    identities.add(id);
    return Object.freeze({ id, from, to: portal.to });
  }));
}
