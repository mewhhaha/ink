import type { Aabb } from "@ink/geometry/shapes.ts";
import { aabb } from "@ink/geometry/shapes.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import { vec3, vec3_add } from "@ink/math/vector.ts";
import type { Observer } from "@ink/observability/observer.ts";
import type {
  AgentProfileId,
  NavigationAreaId,
  NavigationObstacleId,
  NavigationPolygonId,
  NavigationTileId,
  OffMeshLinkId,
} from "./identity.ts";
import type { AgentProfile } from "./profile.ts";
import {
  build_navigation_tile,
  type NavigationObstacle,
  type NavigationPolygon,
  type NavigationTile,
  type NavigationTileInput,
} from "./tile.ts";

export interface NavigationConnection {
  readonly from: NavigationPolygonId;
  readonly to: NavigationPolygonId;
  readonly type: "portal" | "off_mesh";
  readonly left: Vec3;
  readonly right: Vec3;
  readonly cost: number;
  readonly area?: NavigationAreaId;
  readonly link?: OffMeshLinkId;
}

export interface NavigationSnapshotPolygon {
  readonly polygon: NavigationPolygon;
  readonly connections: readonly NavigationConnection[];
}

export interface NavigationSnapshot {
  readonly revision: number;
  readonly profile: AgentProfileId;
  readonly tiles: readonly NavigationTile[];
  readonly polygons: readonly NavigationSnapshotPolygon[];
  readonly obstacles: readonly NavigationObstacle[];
}

export type NavigationMutationResult =
  | { readonly type: "changed"; readonly revision: number }
  | { readonly type: "unchanged"; readonly revision: number }
  | { readonly type: "failed"; readonly reason: string };

export type NavigationRebuildResult =
  | {
    readonly type: "rebuilt";
    readonly revision: number;
    readonly rebuilt: readonly NavigationTileId[];
    readonly deferred: readonly NavigationTileId[];
  }
  | {
    readonly type: "cancelled";
    readonly affected: readonly NavigationTileId[];
  }
  | {
    readonly type: "failed";
    readonly tile: NavigationTileId;
    readonly reason: string;
  };

export interface NavigationMeshOptions {
  readonly profile: AgentProfile;
  readonly observer?: Observer;
}

export interface NavigationRebaseStage {
  commit(): void;
  rollback(): void;
}

export class NavigationMesh {
  readonly #profile: AgentProfile;
  readonly #observer: Observer | undefined;
  readonly #tiles = new Map<NavigationTileId, NavigationTile>();
  #obstacles: readonly NavigationObstacle[] = Object.freeze([]);
  #translation = vec3(0, 0, 0);
  #revision = 0;

  constructor(options: NavigationMeshOptions) {
    this.#profile = options.profile;
    this.#observer = options.observer;
  }

  get revision(): number {
    return this.#revision;
  }

  publish(tile: NavigationTile): NavigationMutationResult {
    return this.replace_tiles([], [tile]);
  }

  replace_tiles(
    removed: readonly NavigationTileId[],
    published: readonly NavigationTile[],
  ): NavigationMutationResult {
    const next = new Map(this.#tiles);
    for (const id of [...new Set(removed)].sort()) next.delete(id);
    const published_ids = new Set<NavigationTileId>();
    for (
      const tile of [...published].sort((left, right) =>
        left.id.localeCompare(right.id)
      )
    ) {
      if (tile.profile !== this.#profile.id) {
        return {
          type: "failed",
          reason: `navigation tile ${JSON.stringify(tile.id)} profile ${
            JSON.stringify(tile.profile)
          } does not match mesh profile ${JSON.stringify(this.#profile.id)}`,
        };
      }
      if (published_ids.has(tile.id)) {
        return {
          type: "failed",
          reason: `navigation replacement repeats tile ${
            JSON.stringify(tile.id)
          }`,
        };
      }
      published_ids.add(tile.id);
      next.set(tile.id, tile);
    }
    const validation = validate_tiles([...next.values()]);
    if (validation !== undefined) return { type: "failed", reason: validation };
    if (same_tiles(this.#tiles, next)) {
      return { type: "unchanged", revision: this.#revision };
    }
    this.#tiles.clear();
    for (
      const [id, tile] of [...next].sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ) {
      this.#tiles.set(id, tile);
    }
    this.#revision += 1;
    this.#observer?.event("navigation.mesh.tiles_replaced", {
      revision: this.#revision,
      published: published.length,
      removed: removed.length,
      resident_tiles: this.#tiles.size,
    });
    return { type: "changed", revision: this.#revision };
  }

  remove(id: NavigationTileId): NavigationMutationResult {
    if (!this.#tiles.has(id)) {
      return { type: "unchanged", revision: this.#revision };
    }
    return this.replace_tiles([id], []);
  }

  set_obstacles(
    obstacles: readonly NavigationObstacle[],
  ): NavigationMutationResult {
    let parsed: readonly NavigationObstacle[];
    try {
      parsed = parse_obstacles(obstacles);
    } catch (error) {
      return {
        type: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (same_obstacles(this.#obstacles, parsed)) {
      return { type: "unchanged", revision: this.#revision };
    }
    this.#obstacles = parsed;
    this.#revision += 1;
    this.#observer?.event("navigation.mesh.obstacles_changed", {
      revision: this.#revision,
      obstacles: parsed.length,
    });
    return { type: "changed", revision: this.#revision };
  }

  async rebuild_obstacles(
    sources: readonly NavigationTileInput[],
    obstacles: readonly NavigationObstacle[],
    options: {
      readonly maximum_tiles: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<NavigationRebuildResult> {
    if (
      !Number.isSafeInteger(options.maximum_tiles) || options.maximum_tiles < 0
    ) {
      throw new Error(
        `navigation obstacle rebuild maximum tiles ${
          JSON.stringify(options.maximum_tiles)
        } must be a nonnegative safe integer`,
      );
    }
    const parsed_obstacles = parse_obstacles(obstacles);
    const rebuild_obstacles = [...this.#obstacles, ...parsed_obstacles];
    const affected = [...sources].filter((source) =>
      rebuild_obstacles.some((obstacle) =>
        bounds_overlap(input_bounds(source), obstacle.bounds)
      )
    ).sort((left, right) => left.id.localeCompare(right.id));
    const selected = affected.slice(0, options.maximum_tiles);
    const deferred = affected.slice(options.maximum_tiles).map(({ id }) => id);
    const built: NavigationTile[] = [];
    for (const source of selected) {
      await Promise.resolve();
      if (options.signal?.aborted) {
        return {
          type: "cancelled",
          affected: Object.freeze(affected.map(({ id }) => id)),
        };
      }
      const result = build_navigation_tile(
        { ...source, obstacles: parsed_obstacles },
        this.#profile,
        { signal: options.signal, observer: this.#observer },
      );
      if (result.type === "cancelled") {
        return {
          type: "cancelled",
          affected: Object.freeze(affected.map(({ id }) => id)),
        };
      }
      if (result.type !== "ready") {
        return { type: "failed", tile: source.id, reason: result.reason };
      }
      built.push(result.tile);
    }
    if (options.signal?.aborted) {
      return {
        type: "cancelled",
        affected: Object.freeze(affected.map(({ id }) => id)),
      };
    }
    const obstacles_changed = !same_obstacles(
      this.#obstacles,
      parsed_obstacles,
    );
    const changed_tiles = this.replace_tiles([], built);
    if (changed_tiles.type === "failed") {
      return {
        type: "failed",
        tile: selected[0]?.id ?? affected[0]?.id!,
        reason: changed_tiles.reason,
      };
    }
    this.#obstacles = parsed_obstacles;
    if (changed_tiles.type === "unchanged" && obstacles_changed) {
      this.#revision += 1;
    }
    this.#observer?.event("navigation.mesh.obstacles_rebuilt", {
      revision: this.#revision,
      rebuilt_tiles: built.length,
      deferred_tiles: deferred.length,
    });
    return {
      type: "rebuilt",
      revision: this.#revision,
      rebuilt: Object.freeze(built.map(({ id }) => id)),
      deferred: Object.freeze(deferred),
    };
  }

  rebase(translation: Vec3): NavigationMutationResult {
    if (translation.x === 0 && translation.y === 0 && translation.z === 0) {
      return { type: "unchanged", revision: this.#revision };
    }
    this.stage_rebase(translation).commit();
    return { type: "changed", revision: this.#revision };
  }

  stage_rebase(translation: Vec3): NavigationRebaseStage {
    let state: "staged" | "committed" | "rolled_back" = "staged";
    const changed = translation.x !== 0 || translation.y !== 0 ||
      translation.z !== 0;
    const previous_revision = this.#revision;
    return {
      commit: () => {
        if (state !== "staged") {
          throw new Error(
            `navigation rebase stage cannot commit from ${state}`,
          );
        }
        if (changed) {
          this.#translation = vec3_add(this.#translation, translation);
          this.#revision += 1;
        }
        state = "committed";
        if (changed) {
          this.#observer?.event("navigation.mesh.rebased", {
            revision: this.#revision,
            x: translation.x,
            y: translation.y,
            z: translation.z,
          });
        }
      },
      rollback: () => {
        if (state === "rolled_back") return;
        if (state === "committed" && changed) {
          if (this.#revision !== previous_revision + 1) {
            throw new Error(
              `navigation rebase rollback expected revision ${
                previous_revision + 1
              } but mesh is at ${this.#revision}`,
            );
          }
          this.#translation = vec3_add(
            this.#translation,
            vec3(-translation.x, -translation.y, -translation.z),
          );
          this.#revision = previous_revision;
          this.#observer?.event("navigation.mesh.rebase_rolled_back", {
            revision: this.#revision,
          });
        }
        state = "rolled_back";
      },
    };
  }

  snapshot(): NavigationSnapshot {
    const tiles = Object.freeze(
      [...this.#tiles.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((tile) => translate_tile(tile, this.#translation)),
    );
    const obstacles = Object.freeze(
      this.#obstacles.map((obstacle) =>
        Object.freeze({
          ...obstacle,
          bounds: translate_bounds(obstacle.bounds, this.#translation),
        })
      ),
    );
    const polygons = tiles.flatMap(({ polygons }) => polygons).filter((
      polygon,
    ) =>
      !obstacles.some((obstacle) =>
        polygon_overlaps(polygon, obstacle.bounds, this.#profile.height)
      )
    );
    const connections = build_connections(tiles, polygons);
    const snapshot_polygons = Object.freeze(
      polygons.map((polygon) =>
        Object.freeze({
          polygon,
          connections: Object.freeze(
            (connections.get(polygon.id) ?? []).sort(compare_connections),
          ),
        })
      ),
    );
    return Object.freeze({
      revision: this.#revision,
      profile: this.#profile.id,
      tiles,
      polygons: snapshot_polygons,
      obstacles,
    });
  }
}

export function estimate_navigation_snapshot_bytes(
  snapshot: NavigationSnapshot,
): number {
  let bytes = 0;
  for (const tile of snapshot.tiles) {
    bytes += tile.distance_field.length * 8;
    for (const polygon of tile.polygons) {
      bytes += polygon.vertices.length * 3 * 8;
      bytes += polygon.portals.length * 2 * 3 * 8;
      bytes += 3 * 8;
    }
    for (const contour of tile.contours) {
      bytes += contour.segments.length * 2 * 3 * 8;
    }
    for (const detail of tile.details) {
      bytes += detail.triangles.length * 3 * 3 * 8;
    }
  }
  for (const entry of snapshot.polygons) {
    bytes += entry.connections.length * (2 * 3 * 8 + 8);
  }
  bytes += snapshot.obstacles.length * 2 * 3 * 8;
  return bytes;
}

function build_connections(
  tiles: readonly NavigationTile[],
  polygons: readonly NavigationPolygon[],
): Map<NavigationPolygonId, NavigationConnection[]> {
  const present = new Set(polygons.map(({ id }) => id));
  const connections = new Map<NavigationPolygonId, NavigationConnection[]>();
  for (const polygon of polygons) {
    for (const portal of polygon.portals) {
      if (!present.has(portal.to)) continue;
      append_connection(connections, {
        from: polygon.id,
        to: portal.to,
        type: "portal",
        left: portal.left,
        right: portal.right,
        cost: 0,
      });
    }
  }
  const edge_owners = new Map<
    string,
    { polygon: NavigationPolygon; start: Vec3; finish: Vec3 }[]
  >();
  for (const polygon of polygons) {
    for (let edge = 0; edge < polygon.vertices.length; edge += 1) {
      const start = polygon.vertices[edge];
      const finish = polygon.vertices[(edge + 1) % polygon.vertices.length];
      const key = edge_key(start, finish);
      const owners = edge_owners.get(key) ?? [];
      owners.push({ polygon, start, finish });
      edge_owners.set(key, owners);
    }
  }
  const tile_by_id = new Map(tiles.map((tile) => [tile.id, tile]));
  for (const owners of edge_owners.values()) {
    if (
      owners.length !== 2 ||
      owners[0].polygon.tile_id === owners[1].polygon.tile_id
    ) continue;
    const [first, second] = owners;
    const maximum_climb = Math.min(
      tile_by_id.get(first.polygon.tile_id)!.maximum_climb,
      tile_by_id.get(second.polygon.tile_id)!.maximum_climb,
    );
    if (
      Math.abs(first.polygon.center.y - second.polygon.center.y) >
        maximum_climb + 1e-9
    ) continue;
    append_connection(connections, {
      from: first.polygon.id,
      to: second.polygon.id,
      type: "portal",
      left: first.start,
      right: first.finish,
      cost: 0,
    });
    append_connection(connections, {
      from: second.polygon.id,
      to: first.polygon.id,
      type: "portal",
      left: second.start,
      right: second.finish,
      cost: 0,
    });
  }
  for (const tile of tiles) {
    for (const link of tile.links) {
      if (!link.enabled) continue;
      const from = nearest_polygon(polygons, link.start);
      const to = nearest_polygon(polygons, link.finish);
      if (from === undefined || to === undefined || from.id === to.id) continue;
      append_connection(connections, {
        from: from.id,
        to: to.id,
        type: "off_mesh",
        left: link.start,
        right: link.finish,
        cost: link.cost,
        area: link.area,
        link: link.id,
      });
      if (link.direction === "bidirectional") {
        append_connection(connections, {
          from: to.id,
          to: from.id,
          type: "off_mesh",
          left: link.finish,
          right: link.start,
          cost: link.cost,
          area: link.area,
          link: link.id,
        });
      }
    }
  }
  return connections;
}

function validate_tiles(tiles: readonly NavigationTile[]): string | undefined {
  const coordinates = new Set<string>();
  const polygons = new Set<NavigationPolygonId>();
  const links = new Set<OffMeshLinkId>();
  for (const tile of tiles) {
    const coordinate =
      `${tile.coordinate.x}:${tile.coordinate.z}:${tile.coordinate.lod}`;
    if (coordinates.has(coordinate)) {
      return `navigation tiles repeat coordinate ${coordinate}`;
    }
    coordinates.add(coordinate);
    for (const polygon of tile.polygons) {
      if (polygons.has(polygon.id)) {
        return `navigation tiles repeat polygon ${JSON.stringify(polygon.id)}`;
      }
      polygons.add(polygon.id);
    }
    for (const link of tile.links) {
      if (links.has(link.id)) {
        return `navigation tiles repeat off-mesh link ${
          JSON.stringify(link.id)
        }`;
      }
      links.add(link.id);
    }
  }
  for (const tile of tiles) {
    for (const polygon of tile.polygons) {
      for (const portal of polygon.portals) {
        if (!polygons.has(portal.to)) {
          return `navigation polygon ${
            JSON.stringify(polygon.id)
          } references missing polygon ${JSON.stringify(portal.to)}`;
        }
      }
    }
  }
  return undefined;
}

function translate_tile(
  tile: NavigationTile,
  translation: Vec3,
): NavigationTile {
  if (translation.x === 0 && translation.y === 0 && translation.z === 0) {
    return tile;
  }
  const polygons = Object.freeze(tile.polygons.map((polygon) =>
    Object.freeze({
      ...polygon,
      vertices: Object.freeze(
        polygon.vertices.map((point) => vec3_add(point, translation)),
      ),
      center: vec3_add(polygon.center, translation),
      portals: Object.freeze(polygon.portals.map((portal) =>
        Object.freeze({
          ...portal,
          left: vec3_add(portal.left, translation),
          right: vec3_add(portal.right, translation),
        })
      )),
    })
  ));
  return Object.freeze({
    ...tile,
    bounds: translate_bounds(tile.bounds, translation),
    polygons,
    contours: Object.freeze(tile.contours.map((contour) =>
      Object.freeze({
        ...contour,
        segments: Object.freeze(contour.segments.map((segment) =>
          Object.freeze({
            start: vec3_add(segment.start, translation),
            finish: vec3_add(segment.finish, translation),
          })
        )),
      })
    )),
    details: Object.freeze(tile.details.map((detail) =>
      Object.freeze({
        ...detail,
        triangles: Object.freeze(detail.triangles.map((triangle) =>
          Object.freeze([
            vec3_add(triangle[0], translation),
            vec3_add(triangle[1], translation),
            vec3_add(triangle[2], translation),
          ]) as readonly [Vec3, Vec3, Vec3]
        )),
      })
    )),
    links: Object.freeze(tile.links.map((link) =>
      Object.freeze({
        ...link,
        start: vec3_add(link.start, translation),
        finish: vec3_add(link.finish, translation),
      })
    )),
  });
}

function nearest_polygon(
  polygons: readonly NavigationPolygon[],
  point: Vec3,
): NavigationPolygon | undefined {
  return polygons.filter((polygon) => {
    const xs = polygon.vertices.map(({ x }) => x);
    const zs = polygon.vertices.map(({ z }) => z);
    return point.x >= Math.min(...xs) - 1e-7 &&
      point.x <= Math.max(...xs) + 1e-7 &&
      point.z >= Math.min(...zs) - 1e-7 &&
      point.z <= Math.max(...zs) + 1e-7;
  }).sort((left, right) =>
    distance_squared(left.center, point) -
      distance_squared(right.center, point) ||
    left.id.localeCompare(right.id)
  )[0];
}

function parse_obstacles(
  source: readonly NavigationObstacle[],
): readonly NavigationObstacle[] {
  const ids = new Set<NavigationObstacleId>();
  return Object.freeze(
    [...source].sort((left, right) => left.id.localeCompare(right.id)).map(
      (obstacle) => {
        if (ids.has(obstacle.id)) {
          throw new Error(
            `navigation obstacles repeat ${JSON.stringify(obstacle.id)}`,
          );
        }
        ids.add(obstacle.id);
        if (!Number.isSafeInteger(obstacle.revision) || obstacle.revision < 0) {
          throw new Error(
            `navigation obstacle ${JSON.stringify(obstacle.id)} revision ${
              JSON.stringify(obstacle.revision)
            } must be a nonnegative safe integer`,
          );
        }
        return Object.freeze({ ...obstacle });
      },
    ),
  );
}

function polygon_overlaps(
  polygon: NavigationPolygon,
  bounds: Aabb,
  agent_height: number,
): boolean {
  return polygon.center.x >= bounds.minimum.x &&
    polygon.center.x <= bounds.maximum.x &&
    polygon.center.z >= bounds.minimum.z &&
    polygon.center.z <= bounds.maximum.z &&
    polygon.center.y <= bounds.maximum.y &&
    polygon.center.y + agent_height >= bounds.minimum.y;
}

function input_bounds(input: NavigationTileInput): Aabb {
  return aabb(
    vec3(input.origin.x, -Number.MAX_VALUE, input.origin.z),
    vec3(
      input.origin.x + input.width * input.cell_size,
      Number.MAX_VALUE,
      input.origin.z + input.depth * input.cell_size,
    ),
  );
}

function translate_bounds(bounds: Aabb, translation: Vec3): Aabb {
  return aabb(
    vec3_add(bounds.minimum, translation),
    vec3_add(bounds.maximum, translation),
  );
}

function bounds_overlap(left: Aabb, right: Aabb): boolean {
  return left.minimum.x <= right.maximum.x &&
    left.maximum.x >= right.minimum.x &&
    left.minimum.y <= right.maximum.y && left.maximum.y >= right.minimum.y &&
    left.minimum.z <= right.maximum.z && left.maximum.z >= right.minimum.z;
}

function append_connection(
  connections: Map<NavigationPolygonId, NavigationConnection[]>,
  connection: NavigationConnection,
): void {
  const current = connections.get(connection.from) ?? [];
  if (
    !current.some((candidate) =>
      candidate.to === connection.to && candidate.type === connection.type &&
      candidate.link === connection.link
    )
  ) current.push(Object.freeze(connection));
  connections.set(connection.from, current);
}

function edge_key(start: Vec3, finish: Vec3): string {
  const first = `${rounded(start.x)}:${rounded(start.z)}`;
  const second = `${rounded(finish.x)}:${rounded(finish.z)}`;
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function rounded(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function distance_squared(left: Vec3, right: Vec3): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 +
    (left.z - right.z) ** 2;
}

function compare_connections(
  left: NavigationConnection,
  right: NavigationConnection,
): number {
  return left.to.localeCompare(right.to) ||
    left.type.localeCompare(right.type) ||
    (left.link ?? "").localeCompare(right.link ?? "");
}

function same_tiles(
  left: ReadonlyMap<NavigationTileId, NavigationTile>,
  right: ReadonlyMap<NavigationTileId, NavigationTile>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, tile] of left) {
    if (right.get(id) !== tile) return false;
  }
  return true;
}

function same_obstacles(
  left: readonly NavigationObstacle[],
  right: readonly NavigationObstacle[],
): boolean {
  return left.length === right.length &&
    left.every((obstacle, index) =>
      obstacle.id === right[index].id &&
      obstacle.revision === right[index].revision &&
      obstacle.bounds.minimum.x === right[index].bounds.minimum.x &&
      obstacle.bounds.minimum.y === right[index].bounds.minimum.y &&
      obstacle.bounds.minimum.z === right[index].bounds.minimum.z &&
      obstacle.bounds.maximum.x === right[index].bounds.maximum.x &&
      obstacle.bounds.maximum.y === right[index].bounds.maximum.y &&
      obstacle.bounds.maximum.z === right[index].bounds.maximum.z
    );
}
