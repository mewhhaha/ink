import { vec3 } from "@ink/math/vector.ts";
import type { Aabb, Ray } from "./shapes.ts";
import { aabb_center, aabb_union } from "./shapes.ts";
import { aabb_overlap, ray_aabb_intersection } from "./queries.ts";

export interface StaticBvhEntry<Payload> {
  readonly bounds: Aabb;
  readonly payload: Payload;
}

export type StaticBvhNode =
  | {
    readonly type: "branch";
    readonly bounds: Aabb;
    readonly left: number;
    readonly right: number;
  }
  | {
    readonly type: "leaf";
    readonly bounds: Aabb;
    readonly entries: readonly number[];
  };

export interface StaticBvh<Payload> {
  readonly entries: readonly StaticBvhEntry<Payload>[];
  readonly nodes: readonly StaticBvhNode[];
  readonly root: number | null;
}

function combined_bounds(
  entries: readonly StaticBvhEntry<unknown>[],
  indices: readonly number[],
): Aabb {
  let bounds = entries[indices[0]].bounds;
  for (let index = 1; index < indices.length; index++) {
    bounds = aabb_union(bounds, entries[indices[index]].bounds);
  }
  return bounds;
}

export function build_static_bvh<Payload>(
  entries: readonly StaticBvhEntry<Payload>[],
  maximum_leaf_size = 4,
): StaticBvh<Payload> {
  if (!Number.isSafeInteger(maximum_leaf_size) || maximum_leaf_size <= 0) {
    throw new Error(
      `maximum BVH leaf size must be a positive safe integer, received ${maximum_leaf_size}`,
    );
  }
  const copied_entries = Object.freeze(
    entries.map((entry) =>
      Object.freeze({ bounds: entry.bounds, payload: entry.payload })
    ),
  );
  if (entries.length === 0) {
    return Object.freeze({
      entries: copied_entries,
      nodes: Object.freeze([]),
      root: null,
    });
  }
  const nodes: StaticBvhNode[] = [];
  const build_node = (entry_indices: readonly number[]): number => {
    const bounds = combined_bounds(copied_entries, entry_indices);
    if (entry_indices.length <= maximum_leaf_size) {
      const node_index = nodes.length;
      nodes.push(Object.freeze({
        type: "leaf",
        bounds,
        entries: Object.freeze(
          [...entry_indices].sort((left, right) => left - right),
        ),
      }));
      return node_index;
    }
    const centers = entry_indices.map((index) =>
      aabb_center(copied_entries[index].bounds)
    );
    const minimum = centers.reduce((current, center) =>
      vec3(
        Math.min(current.x, center.x),
        Math.min(current.y, center.y),
        Math.min(current.z, center.z),
      )
    );
    const maximum = centers.reduce((current, center) =>
      vec3(
        Math.max(current.x, center.x),
        Math.max(current.y, center.y),
        Math.max(current.z, center.z),
      )
    );
    const extents = [
      maximum.x - minimum.x,
      maximum.y - minimum.y,
      maximum.z - minimum.z,
    ] as const;
    let axis: 0 | 1 | 2 = 0;
    if (extents[1] > extents[axis]) axis = 1;
    if (extents[2] > extents[axis]) axis = 2;
    const coordinate = (index: number): number => {
      const center = aabb_center(copied_entries[index].bounds);
      return axis === 0 ? center.x : axis === 1 ? center.y : center.z;
    };
    const ordered = [...entry_indices].sort((left, right) =>
      coordinate(left) - coordinate(right) || left - right
    );
    const midpoint = Math.floor(ordered.length / 2);
    const left = build_node(ordered.slice(0, midpoint));
    const right = build_node(ordered.slice(midpoint));
    const node_index = nodes.length;
    nodes.push(Object.freeze({ type: "branch", bounds, left, right }));
    return node_index;
  };
  const root = build_node(entries.map((_, index) => index));
  return Object.freeze({
    entries: copied_entries,
    nodes: Object.freeze(nodes),
    root,
  });
}

function collect_candidates<Payload>(
  tree: StaticBvh<Payload>,
  node_matches: (bounds: Aabb) => boolean,
): readonly Payload[] {
  if (tree.root === null) return Object.freeze([]);
  const candidates: number[] = [];
  const pending = [tree.root];
  while (pending.length > 0) {
    const node_index = pending.pop()!;
    const node = tree.nodes[node_index];
    if (!node_matches(node.bounds)) continue;
    if (node.type === "leaf") {
      for (const entry_index of node.entries) {
        if (node_matches(tree.entries[entry_index].bounds)) {
          candidates.push(entry_index);
        }
      }
      continue;
    }
    pending.push(node.right, node.left);
  }
  candidates.sort((left, right) => left - right);
  return Object.freeze(candidates.map((index) => tree.entries[index].payload));
}

export function query_static_bvh<Payload>(
  tree: StaticBvh<Payload>,
  bounds: Aabb,
): readonly Payload[] {
  return collect_candidates(
    tree,
    (candidate) => aabb_overlap(candidate, bounds) !== "disjoint",
  );
}

export function ray_query_static_bvh<Payload>(
  tree: StaticBvh<Payload>,
  cast: Ray,
  maximum_distance = Infinity,
): readonly Payload[] {
  return collect_candidates(
    tree,
    (bounds) => ray_aabb_intersection(cast, bounds, maximum_distance) !== null,
  );
}
