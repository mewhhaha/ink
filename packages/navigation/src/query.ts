import type { Vec3 } from "@ink/math/vector.ts";
import {
  vec3,
  vec3_length,
  vec3_lerp,
  vec3_subtract,
} from "@ink/math/vector.ts";
import type { Observer } from "@ink/observability/observer.ts";
import type {
  NavigationPolygonId,
  NavigationTileId,
  OffMeshLinkId,
} from "./identity.ts";
import type {
  NavigationConnection,
  NavigationSnapshot,
  NavigationSnapshotPolygon,
} from "./navmesh.ts";
import {
  type AgentProfile,
  area_cost,
  type NavigationArea,
} from "./profile.ts";
import type { NavigationPolygon } from "./tile.ts";

export type NearestNavigationPointResult =
  | {
    readonly type: "ready";
    readonly revision: number;
    readonly polygon: NavigationPolygonId;
    readonly point: Vec3;
    readonly distance: number;
  }
  | {
    readonly type: "unavailable";
    readonly revision: number;
    readonly reason: string;
    readonly affected_tile?: NavigationTileId;
  }
  | {
    readonly type: "stale";
    readonly expected_revision: number;
    readonly current_revision: number;
  };

export interface NavigationPath {
  readonly revision: number;
  readonly corridor: readonly NavigationPolygonId[];
  readonly points: readonly Vec3[];
  readonly links: readonly OffMeshLinkId[];
  readonly open_set_expansions: number;
  readonly total_cost: number;
}

export type NavigationPathResult =
  | { readonly type: "complete"; readonly path: NavigationPath }
  | {
    readonly type: "partial";
    readonly path: NavigationPath;
    readonly reason: string;
  }
  | {
    readonly type: "unavailable";
    readonly revision: number;
    readonly endpoint: "start" | "goal" | "mesh";
    readonly reason: string;
    readonly affected_tile?: NavigationTileId;
  }
  | {
    readonly type: "unreachable";
    readonly revision: number;
    readonly start: NavigationPolygonId;
    readonly goal?: NavigationPolygonId;
  }
  | {
    readonly type: "stale";
    readonly expected_revision: number;
    readonly current_revision: number;
  };

export interface NavigationPathOptions {
  readonly profile: AgentProfile;
  readonly areas: ReadonlyMap<NavigationArea["id"], NavigationArea>;
  readonly maximum_snap_distance: number;
  readonly maximum_visited: number;
  readonly allow_partial: boolean;
  readonly expected_revision?: number;
  readonly observer?: Observer;
}

export type NavigationRaycastResult =
  | {
    readonly type: "clear";
    readonly revision: number;
    readonly polygons: readonly NavigationPolygonId[];
  }
  | {
    readonly type: "blocked";
    readonly revision: number;
    readonly point: Vec3;
    readonly polygon?: NavigationPolygonId;
  }
  | Extract<NearestNavigationPointResult, { type: "stale" | "unavailable" }>;

export type ReachabilityResult =
  | { readonly type: "reachable"; readonly revision: number }
  | {
    readonly type: "unreachable";
    readonly revision: number;
    readonly start: NavigationPolygonId;
    readonly goal: NavigationPolygonId;
  }
  | Extract<NavigationPathResult, { type: "stale" | "unavailable" }>;

export type CorridorRepairResult =
  | {
    readonly type: "repaired";
    readonly path: NavigationPath;
    readonly reused_polygons: number;
  }
  | Exclude<NavigationPathResult, { type: "complete" | "partial" }>;

interface SearchRecord {
  readonly id: NavigationPolygonId;
  readonly cost: number;
  readonly heuristic: number;
}

interface SearchResult {
  readonly corridor: readonly NavigationPolygonId[];
  readonly connections: readonly NavigationConnection[];
  readonly cost: number;
  readonly expansions: number;
  readonly reached_goal: boolean;
  readonly limited: boolean;
}

export function nearest_navigation_point(
  snapshot: NavigationSnapshot,
  point: Vec3,
  options: {
    readonly maximum_distance: number;
    readonly expected_revision?: number;
  },
): NearestNavigationPointResult {
  const stale = stale_result(snapshot, options.expected_revision);
  if (stale !== undefined) return stale;
  if (
    !Number.isFinite(options.maximum_distance) || options.maximum_distance < 0
  ) {
    throw new Error(
      `navigation nearest-point maximum distance ${
        JSON.stringify(options.maximum_distance)
      } must be finite and nonnegative`,
    );
  }
  let nearest:
    | { polygon: NavigationPolygon; point: Vec3; distance: number }
    | undefined;
  for (const entry of snapshot.polygons) {
    const candidate = closest_point(entry.polygon, point);
    const distance = vec3_length(vec3_subtract(candidate, point));
    if (
      nearest === undefined || distance < nearest.distance ||
      (distance === nearest.distance &&
        entry.polygon.id.localeCompare(nearest.polygon.id) < 0)
    ) nearest = { polygon: entry.polygon, point: candidate, distance };
  }
  if (nearest === undefined || nearest.distance > options.maximum_distance) {
    return {
      type: "unavailable",
      revision: snapshot.revision,
      reason: nearest === undefined
        ? "navigation snapshot has no resident polygons"
        : `nearest navigation point is ${nearest.distance} away, exceeding ${options.maximum_distance}`,
      ...affected_tile(snapshot, point),
    };
  }
  return {
    type: "ready",
    revision: snapshot.revision,
    polygon: nearest.polygon.id,
    point: nearest.point,
    distance: nearest.distance,
  };
}

export function find_navigation_path(
  snapshot: NavigationSnapshot,
  start: Vec3,
  goal: Vec3,
  options: NavigationPathOptions,
): NavigationPathResult {
  const span = options.observer?.start_span("navigation.query.path", {
    revision: snapshot.revision,
  });
  const finish = (result: NavigationPathResult): NavigationPathResult => {
    const path = result.type === "complete" || result.type === "partial"
      ? result.path
      : undefined;
    span?.end({
      status: result.type,
      polygons: path?.corridor.length ?? 0,
      open_set_expansions: path?.open_set_expansions ?? 0,
    });
    return result;
  };
  const stale = stale_result(snapshot, options.expected_revision);
  if (stale !== undefined) return finish(stale);
  validate_path_options(options);
  if (snapshot.profile !== options.profile.id) {
    return finish({
      type: "unavailable",
      revision: snapshot.revision,
      endpoint: "mesh",
      reason: `navigation snapshot profile ${
        JSON.stringify(snapshot.profile)
      } does not match ${JSON.stringify(options.profile.id)}`,
    });
  }
  for (const entry of snapshot.polygons) {
    const area = options.areas.get(entry.polygon.area);
    if (area === undefined) {
      return finish({
        type: "unavailable",
        revision: snapshot.revision,
        endpoint: "mesh",
        reason: `navigation polygon ${
          JSON.stringify(entry.polygon.id)
        } references unknown area ${JSON.stringify(entry.polygon.area)}`,
      });
    }
    if (!Number.isFinite(area.default_cost) || area.default_cost <= 0) {
      return finish({
        type: "unavailable",
        revision: snapshot.revision,
        endpoint: "mesh",
        reason: `navigation area ${JSON.stringify(area.id)} default cost ${
          JSON.stringify(area.default_cost)
        } must be positive and finite`,
      });
    }
    for (const connection of entry.connections) {
      if (
        connection.area !== undefined &&
        !options.areas.has(connection.area)
      ) {
        return finish({
          type: "unavailable",
          revision: snapshot.revision,
          endpoint: "mesh",
          reason: `navigation connection from ${
            JSON.stringify(connection.from)
          } references unknown area ${JSON.stringify(connection.area)}`,
        });
      }
    }
  }
  const start_result = nearest_navigation_point(snapshot, start, {
    maximum_distance: options.maximum_snap_distance,
  });
  if (start_result.type !== "ready") {
    return finish({
      type: "unavailable",
      revision: snapshot.revision,
      endpoint: "start",
      reason: start_result.type === "unavailable"
        ? start_result.reason
        : "stale start query",
      ...(start_result.type === "unavailable" &&
          start_result.affected_tile !== undefined
        ? { affected_tile: start_result.affected_tile }
        : {}),
    });
  }
  const goal_result = nearest_navigation_point(snapshot, goal, {
    maximum_distance: options.maximum_snap_distance,
  });
  if (goal_result.type !== "ready" && !options.allow_partial) {
    return finish({
      type: "unavailable",
      revision: snapshot.revision,
      endpoint: "goal",
      reason: goal_result.type === "unavailable"
        ? goal_result.reason
        : "stale goal query",
      ...(goal_result.type === "unavailable" &&
          goal_result.affected_tile !== undefined
        ? { affected_tile: goal_result.affected_tile }
        : {}),
    });
  }
  const entries = new Map(
    snapshot.polygons.map((entry) => [entry.polygon.id, entry]),
  );
  const search = search_corridor(
    entries,
    start_result.polygon,
    goal_result.type === "ready" ? goal_result.polygon : undefined,
    goal,
    options,
    minimum_area_cost(options),
  );
  if (search === undefined) {
    return finish({
      type: "unreachable",
      revision: snapshot.revision,
      start: start_result.polygon,
      ...(goal_result.type === "ready" ? { goal: goal_result.polygon } : {}),
    });
  }
  const reached_goal = goal_result.type === "ready" && search.reached_goal;
  if (search.limited && !options.allow_partial) {
    return finish({
      type: "unavailable",
      revision: snapshot.revision,
      endpoint: "mesh",
      reason:
        `navigation path search reached its ${options.maximum_visited}-polygon work limit`,
    });
  }
  if (!reached_goal && !options.allow_partial) {
    return finish({
      type: "unreachable",
      revision: snapshot.revision,
      start: start_result.polygon,
      ...(goal_result.type === "ready" ? { goal: goal_result.polygon } : {}),
    });
  }
  const final_point = reached_goal && goal_result.type === "ready"
    ? goal_result.point
    : entries.get(search.corridor.at(-1)!)!.polygon.center;
  const path = Object.freeze({
    revision: snapshot.revision,
    corridor: Object.freeze(search.corridor),
    points: smooth_path(
      start_result.point,
      final_point,
      search.connections,
      entries,
    ),
    links: Object.freeze(
      search.connections.flatMap((connection) =>
        connection.link === undefined ? [] : [connection.link]
      ),
    ),
    open_set_expansions: search.expansions,
    total_cost: search.cost,
  });
  return reached_goal ? finish({ type: "complete", path }) : finish({
    type: "partial",
    path,
    reason: search.limited
      ? `path search reached its ${options.maximum_visited}-polygon work limit`
      : goal_result.type !== "ready"
      ? "goal is outside resident navigation tiles"
      : "goal polygon is disconnected from the reachable corridor",
  });
}

export function navigation_raycast(
  snapshot: NavigationSnapshot,
  start: Vec3,
  finish: Vec3,
  options: { readonly expected_revision?: number } = {},
): NavigationRaycastResult {
  const stale = stale_result(snapshot, options.expected_revision);
  if (stale !== undefined) return stale;
  if (snapshot.polygons.length === 0) {
    return {
      type: "unavailable",
      revision: snapshot.revision,
      reason: "navigation snapshot has no resident polygons",
    };
  }
  const distance = vec3_length(vec3_subtract(finish, start));
  const cell_size = Math.min(
    ...snapshot.tiles.map(({ cell_size }) => cell_size),
  );
  const steps = Math.max(1, Math.ceil(distance / (cell_size * 0.25)));
  const entries = new Map(
    snapshot.polygons.map((entry) => [entry.polygon.id, entry]),
  );
  const traversed: NavigationPolygonId[] = [];
  let previous: NavigationPolygonId | undefined;
  for (let step = 0; step <= steps; step += 1) {
    const point = vec3_lerp(start, finish, step / steps);
    const polygon = polygon_at(snapshot.polygons, point);
    if (polygon === undefined) {
      return {
        type: "blocked",
        revision: snapshot.revision,
        point,
        ...(previous === undefined ? {} : { polygon: previous }),
      };
    }
    if (polygon.id === previous) continue;
    if (
      previous !== undefined &&
      !entries.get(previous)!.connections.some(({ to, type }) =>
        to === polygon.id && type === "portal"
      )
    ) {
      return {
        type: "blocked",
        revision: snapshot.revision,
        point,
        polygon: previous,
      };
    }
    traversed.push(polygon.id);
    previous = polygon.id;
  }
  return {
    type: "clear",
    revision: snapshot.revision,
    polygons: Object.freeze(traversed),
  };
}

export function navigation_reachability(
  snapshot: NavigationSnapshot,
  start: Vec3,
  goal: Vec3,
  options: NavigationPathOptions,
): ReachabilityResult {
  const result = find_navigation_path(snapshot, start, goal, {
    ...options,
    allow_partial: false,
  });
  if (result.type === "complete") {
    return { type: "reachable", revision: result.path.revision };
  }
  if (result.type === "unreachable") {
    return {
      type: "unreachable",
      revision: result.revision,
      start: result.start,
      goal: result.goal!,
    };
  }
  if (result.type === "partial") {
    return {
      type: "unavailable",
      revision: result.path.revision,
      endpoint: "goal",
      reason: "reachability query produced an unexpected partial path",
    };
  }
  return result;
}

export function repair_navigation_corridor(
  snapshot: NavigationSnapshot,
  previous: readonly NavigationPolygonId[],
  start: Vec3,
  goal: Vec3,
  options: NavigationPathOptions,
): CorridorRepairResult {
  const result = find_navigation_path(snapshot, start, goal, options);
  if (result.type !== "complete" && result.type !== "partial") return result;
  const previous_set = new Set(previous);
  const reused =
    result.path.corridor.filter((id) => previous_set.has(id)).length;
  options.observer?.event("navigation.query.corridor_repaired", {
    revision: snapshot.revision,
    previous_polygons: previous.length,
    repaired_polygons: result.path.corridor.length,
    reused_polygons: reused,
  });
  return { type: "repaired", path: result.path, reused_polygons: reused };
}

function search_corridor(
  entries: ReadonlyMap<NavigationPolygonId, NavigationSnapshotPolygon>,
  start: NavigationPolygonId,
  goal: NavigationPolygonId | undefined,
  goal_point: Vec3,
  options: NavigationPathOptions,
  heuristic_scale: number,
): SearchResult | undefined {
  const open: SearchRecord[] = [{
    id: start,
    cost: 0,
    heuristic: heuristic(entries.get(start)!.polygon.center, goal_point) *
      heuristic_scale,
  }];
  const costs = new Map<NavigationPolygonId, number>([[start, 0]]);
  const parents = new Map<
    NavigationPolygonId,
    { id: NavigationPolygonId; connection: NavigationConnection }
  >();
  const closed = new Set<NavigationPolygonId>();
  let best = start;
  let expansions = 0;
  while (open.length > 0 && expansions < options.maximum_visited) {
    open.sort((left, right) =>
      left.cost + left.heuristic - (right.cost + right.heuristic) ||
      left.heuristic - right.heuristic || left.id.localeCompare(right.id)
    );
    const current = open.shift()!;
    if (closed.has(current.id)) continue;
    closed.add(current.id);
    expansions += 1;
    if (
      heuristic(entries.get(current.id)!.polygon.center, goal_point) <
        heuristic(entries.get(best)!.polygon.center, goal_point) ||
      (heuristic(entries.get(current.id)!.polygon.center, goal_point) ===
          heuristic(entries.get(best)!.polygon.center, goal_point) &&
        current.id.localeCompare(best) < 0)
    ) best = current.id;
    if (current.id === goal) {
      return reconstruct(
        start,
        current.id,
        parents,
        costs.get(current.id)!,
        expansions,
        true,
        false,
      );
    }
    for (const connection of entries.get(current.id)!.connections) {
      const destination = entries.get(connection.to);
      if (destination === undefined || closed.has(connection.to)) continue;
      const area = options.areas.get(
        connection.area ?? destination.polygon.area,
      );
      if (area === undefined) continue;
      const movement = heuristic(
        entries.get(current.id)!.polygon.center,
        destination.polygon.center,
      );
      const cost = current.cost + movement * area_cost(options.profile, area) +
        connection.cost;
      if (cost >= (costs.get(connection.to) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }
      costs.set(connection.to, cost);
      parents.set(connection.to, { id: current.id, connection });
      open.push({
        id: connection.to,
        cost,
        heuristic: heuristic(destination.polygon.center, goal_point) *
          heuristic_scale,
      });
    }
  }
  const limited = open.some(({ id }) => !closed.has(id));
  if (best === start && goal !== start && !limited) return undefined;
  return reconstruct(
    start,
    best,
    parents,
    costs.get(best) ?? 0,
    expansions,
    best === goal,
    limited,
  );
}

function reconstruct(
  start: NavigationPolygonId,
  finish: NavigationPolygonId,
  parents: ReadonlyMap<
    NavigationPolygonId,
    { id: NavigationPolygonId; connection: NavigationConnection }
  >,
  cost: number,
  expansions: number,
  reached_goal: boolean,
  limited: boolean,
): SearchResult {
  const corridor = [finish];
  const connections: NavigationConnection[] = [];
  let current = finish;
  while (current !== start) {
    const parent = parents.get(current)!;
    corridor.push(parent.id);
    connections.push(parent.connection);
    current = parent.id;
  }
  corridor.reverse();
  connections.reverse();
  return {
    corridor: Object.freeze(corridor),
    connections: Object.freeze(connections),
    cost,
    expansions,
    reached_goal,
    limited,
  };
}

function smooth_path(
  start: Vec3,
  goal: Vec3,
  connections: readonly NavigationConnection[],
  entries: ReadonlyMap<NavigationPolygonId, NavigationSnapshotPolygon>,
): readonly Vec3[] {
  if (connections.some(({ type }) => type === "off_mesh")) {
    const points = [start];
    for (const connection of connections) {
      if (connection.type === "off_mesh") {
        points.push(connection.left, connection.right);
      }
    }
    points.push(goal);
    return Object.freeze(deduplicate_points(points));
  }
  const portals = connections.map((connection) => {
    const from = entries.get(connection.from)!.polygon.center;
    const to = entries.get(connection.to)!.polygon.center;
    const direction_x = to.x - from.x;
    const direction_z = to.z - from.z;
    const left_side = direction_x * (connection.left.z - from.z) -
      direction_z * (connection.left.x - from.x);
    const right_side = direction_x * (connection.right.z - from.z) -
      direction_z * (connection.right.x - from.x);
    return left_side >= right_side
      ? { left: connection.left, right: connection.right }
      : { left: connection.right, right: connection.left };
  });
  return funnel(start, goal, portals);
}

function funnel(
  start: Vec3,
  goal: Vec3,
  portals: readonly { readonly left: Vec3; readonly right: Vec3 }[],
): readonly Vec3[] {
  if (portals.length === 0) {
    return Object.freeze(deduplicate_points([start, goal]));
  }
  const path = [start];
  let apex = start;
  let left = portals[0].left;
  let right = portals[0].right;
  let apex_index = 0;
  let left_index = 0;
  let right_index = 0;
  const sequence = [...portals, { left: goal, right: goal }];
  for (let index = 1; index < sequence.length; index += 1) {
    const next_left = sequence[index].left;
    const next_right = sequence[index].right;
    if (signed_area(apex, right, next_right) <= 0) {
      if (same_point(apex, right) || signed_area(apex, left, next_right) > 0) {
        right = next_right;
        right_index = index;
      } else {
        path.push(left);
        apex = left;
        apex_index = left_index;
        left = apex;
        right = apex;
        left_index = apex_index;
        right_index = apex_index;
        index = apex_index;
        continue;
      }
    }
    if (signed_area(apex, left, next_left) >= 0) {
      if (same_point(apex, left) || signed_area(apex, right, next_left) < 0) {
        left = next_left;
        left_index = index;
      } else {
        path.push(right);
        apex = right;
        apex_index = right_index;
        left = apex;
        right = apex;
        left_index = apex_index;
        right_index = apex_index;
        index = apex_index;
      }
    }
  }
  path.push(goal);
  return Object.freeze(deduplicate_points(path));
}

function polygon_at(
  polygons: readonly NavigationSnapshotPolygon[],
  point: Vec3,
): NavigationPolygon | undefined {
  return polygons.map(({ polygon }) => polygon).filter((polygon) => {
    const xs = polygon.vertices.map(({ x }) => x);
    const zs = polygon.vertices.map(({ z }) => z);
    return point.x >= Math.min(...xs) - 1e-7 &&
      point.x <= Math.max(...xs) + 1e-7 &&
      point.z >= Math.min(...zs) - 1e-7 && point.z <= Math.max(...zs) + 1e-7;
  }).sort((left, right) =>
    Math.abs(left.center.y - point.y) - Math.abs(right.center.y - point.y) ||
    left.id.localeCompare(right.id)
  )[0];
}

function closest_point(polygon: NavigationPolygon, point: Vec3): Vec3 {
  const xs = polygon.vertices.map(({ x }) => x);
  const zs = polygon.vertices.map(({ z }) => z);
  return vec3(
    Math.max(Math.min(...xs), Math.min(Math.max(...xs), point.x)),
    polygon.center.y,
    Math.max(Math.min(...zs), Math.min(Math.max(...zs), point.z)),
  );
}

function affected_tile(
  snapshot: NavigationSnapshot,
  point: Vec3,
): { affected_tile?: NavigationTileId } {
  const tile = snapshot.tiles.find(({ bounds }) =>
    point.x >= bounds.minimum.x && point.x <= bounds.maximum.x &&
    point.z >= bounds.minimum.z && point.z <= bounds.maximum.z
  );
  return tile === undefined ? {} : { affected_tile: tile.id };
}

function stale_result(
  snapshot: NavigationSnapshot,
  expected_revision: number | undefined,
): Extract<NavigationPathResult, { type: "stale" }> | undefined {
  if (
    expected_revision === undefined || expected_revision === snapshot.revision
  ) return undefined;
  return {
    type: "stale",
    expected_revision,
    current_revision: snapshot.revision,
  };
}

function validate_path_options(options: NavigationPathOptions): void {
  if (
    !Number.isFinite(options.maximum_snap_distance) ||
    options.maximum_snap_distance < 0
  ) {
    throw new Error(
      `navigation path maximum snap distance ${
        JSON.stringify(options.maximum_snap_distance)
      } must be finite and nonnegative`,
    );
  }
  if (
    !Number.isSafeInteger(options.maximum_visited) ||
    options.maximum_visited <= 0
  ) {
    throw new Error(
      `navigation path maximum visited ${
        JSON.stringify(options.maximum_visited)
      } must be a positive safe integer`,
    );
  }
}

function minimum_area_cost(options: NavigationPathOptions): number {
  return Math.min(
    ...[...options.areas.values()].map((area) =>
      area_cost(options.profile, area)
    ),
  );
}

function heuristic(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function signed_area(a: Vec3, b: Vec3, c: Vec3): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function same_point(left: Vec3, right: Vec3): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function deduplicate_points(points: readonly Vec3[]): Vec3[] {
  const result: Vec3[] = [];
  for (const point of points) {
    if (result.length === 0 || !same_point(result.at(-1)!, point)) {
      result.push(point);
    }
  }
  return result;
}
