import type { Aabb } from "@ink/geometry/shapes.ts";
import { aabb } from "@ink/geometry/shapes.ts";
import {
  type Mat4,
  mat4_multiply,
  mat4_transform_affine_point,
} from "@ink/math/matrix.ts";
import {
  type Transform,
  transform_identity,
  transform_to_mat4,
} from "@ink/math/transform.ts";
import { vec3 } from "@ink/math/vector.ts";
import type { Observer } from "@ink/observability/observer.ts";
import {
  type AttachmentKey,
  scene_node_equal,
  scene_node_id,
  scene_node_key,
  type SceneId,
  type SceneNodeId,
} from "./identity.ts";

export interface SceneNodeSource {
  readonly id: SceneNodeId;
  readonly name?: string;
  readonly parent?: SceneNodeId;
  readonly local_transform: Transform;
  readonly active: boolean;
  readonly layers: number;
  readonly local_bounds?: Aabb;
  readonly attachments: ReadonlyMap<string, unknown>;
}

export interface ResolvedSceneNode extends SceneNodeSource {
  readonly world_transform: Mat4;
  readonly world_active: boolean;
  readonly world_layers: number;
  readonly world_bounds?: Aabb;
  readonly depth: number;
}

export interface SceneSnapshot {
  readonly scene_id: SceneId;
  readonly revision: number;
  readonly nodes: readonly ResolvedSceneNode[];
}

export type SceneDeltaOperation =
  | { readonly type: "upsert"; readonly node: SceneNodeSource }
  | { readonly type: "remove"; readonly id: SceneNodeId };

export interface SceneDelta {
  readonly scene_id: SceneId;
  readonly from_revision: number;
  readonly to_revision: number;
  readonly operations: readonly SceneDeltaOperation[];
}

export interface SceneMutationFailure {
  readonly type: "failed";
  readonly reason: "unknown_node" | "stale_node" | "parent_cycle";
  readonly node: SceneNodeId;
  readonly current_generation?: number;
  readonly path?: readonly SceneNodeId[];
}

export type SceneMutationResult =
  | { readonly type: "changed"; readonly delta: SceneDelta }
  | SceneMutationFailure;

export type SceneCreateResult =
  | {
    readonly type: "created";
    readonly id: SceneNodeId;
    readonly delta: SceneDelta;
  }
  | SceneMutationFailure;

export type SceneDeltaResult =
  | { readonly type: "ready"; readonly delta: SceneDelta }
  | {
    readonly type: "stale_revision";
    readonly requested_revision: number;
    readonly oldest_revision: number;
    readonly current_revision: number;
  };

export type SceneSnapshotResult =
  | { readonly type: "ready"; readonly snapshot: SceneSnapshot }
  | {
    readonly type: "invalid_hierarchy";
    readonly reason: string;
    readonly path: readonly SceneNodeId[];
  };

export interface SceneOptions {
  readonly id: SceneId;
  readonly delta_history_capacity?: number;
  readonly observer?: Observer;
}

export interface CreateSceneNodeOptions {
  readonly name?: string;
  readonly parent?: SceneNodeId;
  readonly local_transform?: Transform;
  readonly active?: boolean;
  readonly layers?: number;
  readonly local_bounds?: Aabb;
}

interface MutableSceneNode {
  readonly id: SceneNodeId;
  name?: string;
  parent?: SceneNodeId;
  readonly children: Set<string>;
  local_transform: Transform;
  active: boolean;
  layers: number;
  local_bounds?: Aabb;
  readonly attachments: Map<string, unknown>;
}

export class Scene {
  readonly #id: SceneId;
  readonly #history_capacity: number;
  readonly #observer: Observer | undefined;
  readonly #nodes = new Map<string, MutableSceneNode>();
  readonly #generations: number[] = [];
  readonly #free_indices: number[] = [];
  readonly #history: SceneDelta[] = [];
  #revision = 0;

  constructor(options: SceneOptions) {
    const capacity = options.delta_history_capacity ?? 256;
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error(
        `scene delta history capacity ${
          JSON.stringify(capacity)
        } must be a positive safe integer`,
      );
    }
    this.#id = options.id;
    this.#history_capacity = capacity;
    this.#observer = options.observer;
  }

  get id(): SceneId {
    return this.#id;
  }

  get revision(): number {
    return this.#revision;
  }

  create_node(options: CreateSceneNodeOptions = {}): SceneCreateResult {
    const parent_result = options.parent === undefined
      ? undefined
      : this.#find(options.parent);
    if (parent_result?.type === "failed") return parent_result;
    const index = this.#free_indices.shift() ?? this.#generations.length;
    const generation = this.#generations[index] ?? 0;
    if (index === this.#generations.length) this.#generations.push(generation);
    const id = scene_node_id(index, generation);
    const name = parse_name(options.name);
    const node: MutableSceneNode = {
      id,
      ...(name === undefined ? {} : { name }),
      ...(options.parent === undefined ? {} : { parent: options.parent }),
      children: new Set(),
      local_transform: options.local_transform ?? transform_identity(),
      active: options.active ?? true,
      layers: parse_layers(options.layers ?? 0xffff_ffff),
      ...(options.local_bounds === undefined
        ? {}
        : { local_bounds: options.local_bounds }),
      attachments: new Map(),
    };
    this.#nodes.set(scene_node_key(id), node);
    parent_result?.node.children.add(scene_node_key(id));
    const delta = this.#commit([{ type: "upsert", node: freeze_source(node) }]);
    return { type: "created", id, delta };
  }

  remove_subtree(id: SceneNodeId): SceneMutationResult {
    const found = this.#find(id);
    if (found.type === "failed") return found;
    const removed: MutableSceneNode[] = [];
    const collect = (node: MutableSceneNode) => {
      for (const child of this.#children(node)) collect(child);
      removed.push(node);
    };
    collect(found.node);
    this.#detach_from_parent(found.node);
    for (const node of removed) this.#retire(node);
    return {
      type: "changed",
      delta: this.#commit(
        removed.map((node) => ({ type: "remove", id: node.id })),
      ),
    };
  }

  remove_and_reparent_children(id: SceneNodeId): SceneMutationResult {
    const found = this.#find(id);
    if (found.type === "failed") return found;
    const node = found.node;
    const parent = node.parent;
    const operations: SceneDeltaOperation[] = [];
    for (const child of this.#children(node)) {
      child.parent = parent;
      if (parent !== undefined) {
        this.#nodes.get(scene_node_key(parent))!.children.add(
          scene_node_key(child.id),
        );
      }
      operations.push({ type: "upsert", node: freeze_source(child) });
    }
    node.children.clear();
    this.#detach_from_parent(node);
    this.#retire(node);
    operations.push({ type: "remove", id });
    return { type: "changed", delta: this.#commit(operations) };
  }

  reparent(id: SceneNodeId, parent?: SceneNodeId): SceneMutationResult {
    const found = this.#find(id);
    if (found.type === "failed") return found;
    const parent_result = parent === undefined ? undefined : this.#find(parent);
    if (parent_result?.type === "failed") return parent_result;
    if (parent !== undefined) {
      const path = this.#cycle_path(id, parent);
      if (path !== undefined) {
        return { type: "failed", reason: "parent_cycle", node: id, path };
      }
    }
    this.#detach_from_parent(found.node);
    found.node.parent = parent;
    parent_result?.node.children.add(scene_node_key(id));
    return {
      type: "changed",
      delta: this.#commit([{
        type: "upsert",
        node: freeze_source(found.node),
      }]),
    };
  }

  set_local_transform(id: SceneNodeId, value: Transform): SceneMutationResult {
    return this.#mutate(id, (node) => node.local_transform = value);
  }

  set_active(id: SceneNodeId, active: boolean): SceneMutationResult {
    return this.#mutate(id, (node) => node.active = active);
  }

  set_layers(id: SceneNodeId, layers: number): SceneMutationResult {
    const parsed = parse_layers(layers);
    return this.#mutate(id, (node) => node.layers = parsed);
  }

  set_local_bounds(id: SceneNodeId, bounds?: Aabb): SceneMutationResult {
    return this.#mutate(id, (node) => node.local_bounds = bounds);
  }

  set_attachment<Value>(
    id: SceneNodeId,
    key: AttachmentKey<Value>,
    value: Value,
  ): SceneMutationResult {
    return this.#mutate(id, (node) => node.attachments.set(key, value));
  }

  remove_attachment(id: SceneNodeId, key: AttachmentKey): SceneMutationResult {
    return this.#mutate(id, (node) => node.attachments.delete(key));
  }

  snapshot(): SceneSnapshot {
    const result = resolve_scene_snapshot(
      this.#id,
      this.#revision,
      this.#sources(),
    );
    if (result.type === "invalid_hierarchy") {
      throw new Error(
        `scene ${JSON.stringify(this.#id)} invariant failed: ${result.reason}`,
      );
    }
    this.#observer?.event("scene.snapshot.resolved", {
      scene_id: this.#id,
      revision: this.#revision,
      node_count: result.snapshot.nodes.length,
    });
    return result.snapshot;
  }

  delta_since(revision: number): SceneDeltaResult {
    if (
      !Number.isSafeInteger(revision) || revision < 0 ||
      revision > this.#revision
    ) {
      throw new Error(
        `scene requested revision ${
          JSON.stringify(revision)
        } must be in 0..${this.#revision}`,
      );
    }
    const oldest = this.#history.at(0)?.from_revision ?? this.#revision;
    if (revision < oldest) {
      return {
        type: "stale_revision",
        requested_revision: revision,
        oldest_revision: oldest,
        current_revision: this.#revision,
      };
    }
    return {
      type: "ready",
      delta: {
        scene_id: this.#id,
        from_revision: revision,
        to_revision: this.#revision,
        operations: this.#history
          .filter((delta) => delta.to_revision > revision)
          .flatMap((delta) => delta.operations),
      },
    };
  }

  #mutate(
    id: SceneNodeId,
    mutation: (node: MutableSceneNode) => void,
  ): SceneMutationResult {
    const found = this.#find(id);
    if (found.type === "failed") return found;
    mutation(found.node);
    return {
      type: "changed",
      delta: this.#commit([{
        type: "upsert",
        node: freeze_source(found.node),
      }]),
    };
  }

  #find(
    id: SceneNodeId,
  ):
    | { readonly type: "ready"; readonly node: MutableSceneNode }
    | SceneMutationFailure {
    const node = this.#nodes.get(scene_node_key(id));
    if (node !== undefined) return { type: "ready", node };
    const current_generation = this.#generations[id.index];
    return current_generation !== undefined &&
        current_generation !== id.generation
      ? {
        type: "failed",
        reason: "stale_node",
        node: id,
        current_generation,
      }
      : { type: "failed", reason: "unknown_node", node: id };
  }

  #cycle_path(
    id: SceneNodeId,
    parent: SceneNodeId,
  ): readonly SceneNodeId[] | undefined {
    const path = [id, parent];
    let current = this.#nodes.get(scene_node_key(parent));
    while (current?.parent !== undefined) {
      path.push(current.parent);
      if (scene_node_equal(current.parent, id)) return path;
      current = this.#nodes.get(scene_node_key(current.parent));
    }
    return scene_node_equal(id, parent) ? path : undefined;
  }

  #children(node: MutableSceneNode): readonly MutableSceneNode[] {
    return Array.from(node.children, (key) => this.#nodes.get(key)!)
      .sort((left, right) => left.id.index - right.id.index);
  }

  #detach_from_parent(node: MutableSceneNode): void {
    if (node.parent !== undefined) {
      this.#nodes.get(scene_node_key(node.parent))!.children.delete(
        scene_node_key(node.id),
      );
    }
  }

  #retire(node: MutableSceneNode): void {
    this.#nodes.delete(scene_node_key(node.id));
    this.#generations[node.id.index] += 1;
    const insertion = this.#free_indices.findIndex((index) =>
      index > node.id.index
    );
    if (insertion < 0) this.#free_indices.push(node.id.index);
    else this.#free_indices.splice(insertion, 0, node.id.index);
  }

  #sources(): readonly SceneNodeSource[] {
    return Array.from(this.#nodes.values(), freeze_source);
  }

  #commit(operations: readonly SceneDeltaOperation[]): SceneDelta {
    const delta: SceneDelta = {
      scene_id: this.#id,
      from_revision: this.#revision,
      to_revision: this.#revision + 1,
      operations,
    };
    this.#revision += 1;
    this.#history.push(delta);
    if (this.#history.length > this.#history_capacity) this.#history.shift();
    this.#observer?.event("scene.changed", {
      scene_id: this.#id,
      revision: this.#revision,
      operation_count: operations.length,
    });
    return delta;
  }
}

export function apply_scene_delta(
  snapshot: SceneSnapshot,
  delta: SceneDelta,
): SceneSnapshotResult {
  if (delta.scene_id !== snapshot.scene_id) {
    return {
      type: "invalid_hierarchy",
      reason: `delta scene ${
        JSON.stringify(delta.scene_id)
      } does not match snapshot scene ${JSON.stringify(snapshot.scene_id)}`,
      path: [],
    };
  }
  if (delta.from_revision !== snapshot.revision) {
    return {
      type: "invalid_hierarchy",
      reason:
        `delta starts at revision ${delta.from_revision} but snapshot is revision ${snapshot.revision}`,
      path: [],
    };
  }
  const sources = new Map(
    snapshot.nodes.map((
      node,
    ) => [scene_node_key(node.id), source_from_resolved(node)]),
  );
  for (const operation of delta.operations) {
    if (operation.type === "remove") {
      sources.delete(scene_node_key(operation.id));
    } else sources.set(scene_node_key(operation.node.id), operation.node);
  }
  return resolve_scene_snapshot(
    snapshot.scene_id,
    delta.to_revision,
    Array.from(sources.values()),
  );
}

export function resolve_scene_snapshot(
  id: SceneId,
  revision: number,
  sources: readonly SceneNodeSource[],
): SceneSnapshotResult {
  const by_id = new Map<string, SceneNodeSource>();
  for (const node of sources) {
    const key = scene_node_key(node.id);
    if (by_id.has(key)) {
      return {
        type: "invalid_hierarchy",
        reason: `scene node ${key} appears more than once`,
        path: [node.id],
      };
    }
    by_id.set(key, node);
  }
  for (const node of sources) {
    if (node.parent !== undefined && !by_id.has(scene_node_key(node.parent))) {
      return {
        type: "invalid_hierarchy",
        reason: `scene node ${scene_node_key(node.id)} has unknown parent ${
          scene_node_key(node.parent)
        }`,
        path: [node.id, node.parent],
      };
    }
  }
  const children = new Map<string, SceneNodeSource[]>();
  const roots: SceneNodeSource[] = [];
  for (const node of sources) {
    if (node.parent === undefined) {
      roots.push(node);
      continue;
    }
    const parent_key = scene_node_key(node.parent);
    const siblings = children.get(parent_key) ?? [];
    siblings.push(node);
    children.set(parent_key, siblings);
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
    const local_matrix = transform_to_mat4(node.local_transform);
    const world_transform = parent === undefined
      ? local_matrix
      : mat4_multiply(parent.world_transform, local_matrix);
    resolved.set(scene_node_key(node.id), {
      ...node,
      world_transform,
      world_active: (parent?.world_active ?? true) && node.active,
      world_layers: ((parent?.world_layers ?? 0xffff_ffff) & node.layers) >>> 0,
      ...(node.local_bounds === undefined ? {} : {
        world_bounds: transform_bounds(node.local_bounds, world_transform),
      }),
      depth: (parent?.depth ?? -1) + 1,
    });
    const node_children = children.get(scene_node_key(node.id)) ?? [];
    for (let index = node_children.length - 1; index >= 0; index -= 1) {
      pending.push(node_children[index]);
    }
  }
  if (resolved.size !== sources.length) {
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
        return {
          type: "invalid_hierarchy",
          reason: `scene hierarchy cycle is ${
            cycle.map(scene_node_key).join(" -> ")
          }`,
          path: cycle,
        };
      }
      positions.set(key, path.length);
      path.push(current.id);
      current = current.parent === undefined
        ? undefined
        : by_id.get(scene_node_key(current.parent));
    }
    return {
      type: "invalid_hierarchy",
      reason: `scene node ${
        scene_node_key(unresolved.id)
      } could not be resolved`,
      path,
    };
  }
  return {
    type: "ready",
    snapshot: {
      scene_id: id,
      revision,
      nodes: Array.from(resolved.values()).sort((left, right) =>
        left.depth - right.depth || compare_nodes(left, right)
      ),
    },
  };
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

function freeze_source(node: MutableSceneNode): SceneNodeSource {
  return {
    id: node.id,
    ...(node.name === undefined ? {} : { name: node.name }),
    ...(node.parent === undefined ? {} : { parent: node.parent }),
    local_transform: node.local_transform,
    active: node.active,
    layers: node.layers,
    ...(node.local_bounds === undefined
      ? {}
      : { local_bounds: node.local_bounds }),
    attachments: new Map(node.attachments),
  };
}

function source_from_resolved(node: ResolvedSceneNode): SceneNodeSource {
  return {
    id: node.id,
    ...(node.name === undefined ? {} : { name: node.name }),
    ...(node.parent === undefined ? {} : { parent: node.parent }),
    local_transform: node.local_transform,
    active: node.active,
    layers: node.layers,
    ...(node.local_bounds === undefined
      ? {}
      : { local_bounds: node.local_bounds }),
    attachments: new Map(node.attachments),
  };
}

function compare_nodes(left: SceneNodeSource, right: SceneNodeSource): number {
  return left.id.index - right.id.index ||
    left.id.generation - right.id.generation;
}

function parse_layers(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(
      `scene layers ${
        JSON.stringify(value)
      } must be an unsigned 32-bit integer`,
    );
  }
  return value >>> 0;
}

function parse_name(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = value.trim();
  if (parsed.length === 0) {
    throw new Error(`scene node name ${JSON.stringify(value)} cannot be empty`);
  }
  return parsed;
}
