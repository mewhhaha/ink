import type { Aabb } from "@ink/geometry/shapes.ts";
import { aabb } from "@ink/geometry/shapes.ts";
import {
  type Mat4,
  mat4_multiply,
  mat4_transform_affine_point,
} from "@ink/math/matrix.ts";
import type { Transform } from "@ink/math/transform.ts";
import { transform_to_mat4 } from "@ink/math/transform.ts";
import { vec3 } from "@ink/math/vector.ts";
import {
  scene_node_id,
  scene_node_key,
  type SceneId,
  type SceneNodeId,
} from "./identity.ts";

export interface SceneNodeSource {
  readonly id: SceneNodeId;
  readonly parent?: SceneNodeId;
  readonly local_transform: Transform;
  readonly active: boolean;
  readonly layers: number;
  readonly local_bounds?: Aabb;
}

export interface SceneSource {
  readonly id: SceneId;
  readonly revision: number;
  readonly nodes: readonly SceneNodeSource[];
}

export interface ResolvedSceneNode extends SceneNodeSource {
  readonly world_transform: Mat4;
  readonly world_active: boolean;
  readonly world_layers: number;
  readonly world_bounds?: Aabb;
  readonly depth: number;
}

export interface ResolvedScene {
  readonly id: SceneId;
  readonly revision: number;
  readonly nodes: readonly ResolvedSceneNode[];
}

export type SceneResolution =
  | { readonly type: "ready"; readonly scene: ResolvedScene }
  | {
    readonly type: "invalid_hierarchy";
    readonly reason: string;
    readonly path: readonly SceneNodeId[];
  };

export function resolve_scene(source: SceneSource): SceneResolution {
  if (!Number.isSafeInteger(source.revision) || source.revision < 0) {
    return failure(
      `scene revision ${
        String(source.revision)
      } must be a nonnegative safe integer`,
      [],
    );
  }
  const by_id = new Map<string, SceneNodeSource>();
  const generation_by_index = new Map<number, number>();
  for (const node of source.nodes) {
    const key = scene_node_key(node.id);
    if (by_id.has(key)) {
      return failure(`scene node ${key} appears more than once`, [node.id]);
    }
    const generation = generation_by_index.get(node.id.index);
    if (generation !== undefined && generation !== node.id.generation) {
      return failure(
        `scene node index ${node.id.index} contains generations ${generation} and ${node.id.generation}`,
        [scene_node_id(node.id.index, generation), node.id],
      );
    }
    if (typeof node.active !== "boolean") {
      return failure(`scene node ${key} active state must be boolean`, [
        node.id,
      ]);
    }
    if (
      !Number.isSafeInteger(node.layers) || node.layers < 0 ||
      node.layers > 0xffff_ffff
    ) {
      return failure(
        `scene node ${key} layers ${String(node.layers)} are invalid`,
        [node.id],
      );
    }
    generation_by_index.set(node.id.index, node.id.generation);
    by_id.set(key, node);
  }
  for (const node of source.nodes) {
    if (node.parent === undefined || by_id.has(scene_node_key(node.parent))) {
      continue;
    }
    return failure(
      `scene node ${scene_node_key(node.id)} has unknown parent ${
        scene_node_key(node.parent)
      }`,
      [node.id, node.parent],
    );
  }

  const children = new Map<string, SceneNodeSource[]>();
  const roots: SceneNodeSource[] = [];
  for (const node of source.nodes) {
    if (node.parent === undefined) {
      roots.push(node);
      continue;
    }
    const key = scene_node_key(node.parent);
    const siblings = children.get(key) ?? [];
    siblings.push(node);
    children.set(key, siblings);
  }
  roots.sort(compare_nodes);
  for (const siblings of children.values()) siblings.sort(compare_nodes);

  const resolved = new Map<string, ResolvedSceneNode>();
  const pending = [...roots].reverse();
  while (pending.length > 0) {
    const node = pending.pop()!;
    const parent = node.parent === undefined
      ? undefined
      : resolved.get(scene_node_key(node.parent));
    if (node.parent !== undefined && parent === undefined) continue;
    const local_transform = transform_to_mat4(node.local_transform);
    const world_transform = parent === undefined
      ? local_transform
      : mat4_multiply(parent.world_transform, local_transform);
    resolved.set(
      scene_node_key(node.id),
      Object.freeze({
        ...node,
        world_transform,
        world_active: (parent?.world_active ?? true) && node.active,
        world_layers: ((parent?.world_layers ?? 0xffff_ffff) & node.layers) >>>
          0,
        ...(node.local_bounds === undefined ? {} : {
          world_bounds: transform_bounds(node.local_bounds, world_transform),
        }),
        depth: (parent?.depth ?? -1) + 1,
      }),
    );
    const descendants = children.get(scene_node_key(node.id)) ?? [];
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      pending.push(descendants[index]);
    }
  }

  if (resolved.size !== source.nodes.length) {
    return cycle_failure(source.nodes, by_id, resolved);
  }
  return {
    type: "ready",
    scene: Object.freeze({
      id: source.id,
      revision: source.revision,
      nodes: Object.freeze(
        [...resolved.values()].sort((left, right) =>
          left.depth - right.depth || compare_nodes(left, right)
        ),
      ),
    }),
  };
}

function cycle_failure(
  sources: readonly SceneNodeSource[],
  by_id: ReadonlyMap<string, SceneNodeSource>,
  resolved: ReadonlyMap<string, ResolvedSceneNode>,
): SceneResolution {
  const unresolved = [...sources].sort(compare_nodes).find((node) =>
    !resolved.has(scene_node_key(node.id))
  )!;
  const path: SceneNodeId[] = [];
  const positions = new Map<string, number>();
  let current: SceneNodeSource | undefined = unresolved;
  while (current !== undefined) {
    const key = scene_node_key(current.id);
    const position = positions.get(key);
    if (position !== undefined) {
      const cycle = [...path.slice(position), current.id];
      return failure(
        `scene hierarchy cycle is ${cycle.map(scene_node_key).join(" -> ")}`,
        cycle,
      );
    }
    positions.set(key, path.length);
    path.push(current.id);
    current = current.parent === undefined
      ? undefined
      : by_id.get(scene_node_key(current.parent));
  }
  return failure(
    `scene node ${scene_node_key(unresolved.id)} could not be resolved`,
    path,
  );
}

function failure(
  reason: string,
  path: readonly SceneNodeId[],
): SceneResolution {
  return { type: "invalid_hierarchy", reason, path: Object.freeze([...path]) };
}

function compare_nodes(left: SceneNodeSource, right: SceneNodeSource): number {
  return left.id.index - right.id.index ||
    left.id.generation - right.id.generation;
}

function transform_bounds(bounds: Aabb, matrix: Mat4): Aabb {
  const points = [
    vec3(bounds.minimum.x, bounds.minimum.y, bounds.minimum.z),
    vec3(bounds.minimum.x, bounds.minimum.y, bounds.maximum.z),
    vec3(bounds.minimum.x, bounds.maximum.y, bounds.minimum.z),
    vec3(bounds.minimum.x, bounds.maximum.y, bounds.maximum.z),
    vec3(bounds.maximum.x, bounds.minimum.y, bounds.minimum.z),
    vec3(bounds.maximum.x, bounds.minimum.y, bounds.maximum.z),
    vec3(bounds.maximum.x, bounds.maximum.y, bounds.minimum.z),
    vec3(bounds.maximum.x, bounds.maximum.y, bounds.maximum.z),
  ].map((point) => mat4_transform_affine_point(matrix, point));
  return aabb(
    vec3(
      Math.min(...points.map((point) => point.x)),
      Math.min(...points.map((point) => point.y)),
      Math.min(...points.map((point) => point.z)),
    ),
    vec3(
      Math.max(...points.map((point) => point.x)),
      Math.max(...points.map((point) => point.y)),
      Math.max(...points.map((point) => point.z)),
    ),
  );
}
