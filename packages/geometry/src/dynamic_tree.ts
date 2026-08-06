import type { Aabb } from "./shapes.ts";
import { aabb_surface_area, aabb_union } from "./shapes.ts";
import { aabb_overlap } from "./queries.ts";

declare const dynamic_tree_handle_brand: unique symbol;

export interface DynamicTreeHandle {
  readonly id: number;
  readonly [dynamic_tree_handle_brand]: true;
}

export interface DynamicTreeMatch<Payload> {
  readonly handle: DynamicTreeHandle;
  readonly payload: Payload;
}

export interface DynamicTreeValidationError {
  readonly node: number;
  readonly invariant: string;
}

interface DynamicLeaf<Payload> {
  readonly type: "leaf";
  readonly id: number;
  parent: number | null;
  readonly height: 0;
  bounds: Aabb;
  readonly handle: DynamicTreeHandle;
  payload: Payload;
}

interface DynamicBranch {
  readonly type: "branch";
  readonly id: number;
  parent: number | null;
  height: number;
  bounds: Aabb;
  left: number;
  right: number;
}

type DynamicNode<Payload> = DynamicLeaf<Payload> | DynamicBranch;

function bounds_equal(left: Aabb, right: Aabb): boolean {
  return left.minimum.x === right.minimum.x &&
    left.minimum.y === right.minimum.y &&
    left.minimum.z === right.minimum.z &&
    left.maximum.x === right.maximum.x &&
    left.maximum.y === right.maximum.y &&
    left.maximum.z === right.maximum.z;
}

export class DynamicAabbTree<Payload> {
  #nodes = new Map<number, DynamicNode<Payload>>();
  #leaves = new Map<number, number>();
  #root: number | null = null;
  #next_node_id = 0;
  #next_handle_id = 0;

  insert(bounds: Aabb, payload: Payload): DynamicTreeHandle {
    const handle = Object.freeze({
      id: this.#next_handle_id++,
    }) as DynamicTreeHandle;
    const leaf: DynamicLeaf<Payload> = {
      type: "leaf",
      id: this.#next_node_id++,
      parent: null,
      height: 0,
      bounds,
      handle,
      payload,
    };
    this.#nodes.set(leaf.id, leaf);
    this.#leaves.set(handle.id, leaf.id);
    this.#insert_leaf(leaf);
    return handle;
  }

  update(handle: DynamicTreeHandle, bounds: Aabb): void {
    const leaf = this.#leaf(handle);
    if (bounds_equal(leaf.bounds, bounds)) return;
    this.#detach_leaf(leaf);
    leaf.bounds = bounds;
    this.#insert_leaf(leaf);
  }

  replace(handle: DynamicTreeHandle, payload: Payload): void {
    this.#leaf(handle).payload = payload;
  }

  remove(handle: DynamicTreeHandle): Payload {
    const leaf = this.#leaf(handle);
    this.#detach_leaf(leaf);
    this.#nodes.delete(leaf.id);
    this.#leaves.delete(handle.id);
    return leaf.payload;
  }

  query(bounds: Aabb): readonly DynamicTreeMatch<Payload>[] {
    if (this.#root === null) return Object.freeze([]);
    const matches: DynamicTreeMatch<Payload>[] = [];
    const pending = [this.#root];
    while (pending.length > 0) {
      const node = this.#node(pending.pop()!);
      if (aabb_overlap(node.bounds, bounds) === "disjoint") continue;
      if (node.type === "leaf") {
        matches.push(
          Object.freeze({ handle: node.handle, payload: node.payload }),
        );
      } else {
        pending.push(node.right, node.left);
      }
    }
    matches.sort((left, right) => left.handle.id - right.handle.id);
    return Object.freeze(matches);
  }

  validate(): readonly DynamicTreeValidationError[] {
    const errors: DynamicTreeValidationError[] = [];
    if (this.#root === null) {
      if (this.#nodes.size !== 0) {
        errors.push({
          node: -1,
          invariant: `empty root has ${this.#nodes.size} nodes`,
        });
      }
      return Object.freeze(errors);
    }
    const root = this.#nodes.get(this.#root);
    if (root === undefined) {
      return Object.freeze([{
        node: this.#root,
        invariant: "root node is missing",
      }]);
    }
    if (root.parent !== null) {
      errors.push({
        node: root.id,
        invariant: `root parent is ${root.parent}, expected null`,
      });
    }
    const visited = new Set<number>();
    const visit = (
      node_id: number,
    ): { bounds: Aabb; height: number } | null => {
      if (visited.has(node_id)) {
        errors.push({
          node: node_id,
          invariant: "node is reachable more than once",
        });
        return null;
      }
      visited.add(node_id);
      const node = this.#nodes.get(node_id);
      if (node === undefined) {
        errors.push({ node: node_id, invariant: "node is missing" });
        return null;
      }
      if (node.type === "leaf") {
        if (this.#leaves.get(node.handle.id) !== node.id) {
          errors.push({
            node: node.id,
            invariant: `handle ${node.handle.id} does not map to leaf`,
          });
        }
        return { bounds: node.bounds, height: 0 };
      }
      const left = visit(node.left);
      const right = visit(node.right);
      for (const child_id of [node.left, node.right]) {
        const child = this.#nodes.get(child_id);
        if (child !== undefined && child.parent !== node.id) {
          errors.push({
            node: child.id,
            invariant: `parent is ${child.parent}, expected ${node.id}`,
          });
        }
      }
      if (left === null || right === null) return null;
      const expected_height = 1 + Math.max(left.height, right.height);
      if (node.height !== expected_height) {
        errors.push({
          node: node.id,
          invariant: `height is ${node.height}, expected ${expected_height}`,
        });
      }
      const expected_bounds = aabb_union(left.bounds, right.bounds);
      if (!bounds_equal(node.bounds, expected_bounds)) {
        errors.push({
          node: node.id,
          invariant: "bounds do not contain exactly both children",
        });
      }
      return { bounds: expected_bounds, height: expected_height };
    };
    visit(this.#root);
    for (const node_id of this.#nodes.keys()) {
      if (!visited.has(node_id)) {
        errors.push({
          node: node_id,
          invariant: "node is unreachable from root",
        });
      }
    }
    return Object.freeze(errors.map((error) => Object.freeze(error)));
  }

  #node(node_id: number): DynamicNode<Payload> {
    const node = this.#nodes.get(node_id);
    if (node === undefined) {
      throw new Error(`dynamic AABB tree node ${node_id} is missing`);
    }
    return node;
  }

  #leaf(handle: DynamicTreeHandle): DynamicLeaf<Payload> {
    const node_id = this.#leaves.get(handle.id);
    if (node_id === undefined) {
      throw new Error(`dynamic AABB tree handle ${handle.id} does not exist`);
    }
    const node = this.#node(node_id);
    if (node.type !== "leaf") {
      throw new Error(
        `dynamic AABB tree handle ${handle.id} maps to branch ${node.id}`,
      );
    }
    return node;
  }

  #insert_leaf(leaf: DynamicLeaf<Payload>): void {
    if (this.#root === null) {
      this.#root = leaf.id;
      leaf.parent = null;
      return;
    }
    let sibling = this.#node(this.#root);
    while (sibling.type === "branch") {
      const left = this.#node(sibling.left);
      const right = this.#node(sibling.right);
      const left_cost =
        aabb_surface_area(aabb_union(left.bounds, leaf.bounds)) -
        aabb_surface_area(left.bounds);
      const right_cost =
        aabb_surface_area(aabb_union(right.bounds, leaf.bounds)) -
        aabb_surface_area(right.bounds);
      sibling = left_cost <= right_cost ? left : right;
    }
    const old_parent_id = sibling.parent;
    const parent: DynamicBranch = {
      type: "branch",
      id: this.#next_node_id++,
      parent: old_parent_id,
      height: sibling.height + 1,
      bounds: aabb_union(sibling.bounds, leaf.bounds),
      left: sibling.id,
      right: leaf.id,
    };
    this.#nodes.set(parent.id, parent);
    sibling.parent = parent.id;
    leaf.parent = parent.id;
    if (old_parent_id === null) {
      this.#root = parent.id;
    } else {
      const old_parent = this.#node(old_parent_id);
      if (old_parent.type !== "branch") {
        throw new Error(`dynamic AABB tree parent ${old_parent_id} is a leaf`);
      }
      if (old_parent.left === sibling.id) old_parent.left = parent.id;
      else if (old_parent.right === sibling.id) old_parent.right = parent.id;
      else {throw new Error(
          `parent ${old_parent.id} does not reference child ${sibling.id}`,
        );}
    }
    this.#refit(parent.id);
  }

  #detach_leaf(leaf: DynamicLeaf<Payload>): void {
    if (leaf.id === this.#root) {
      this.#root = null;
      leaf.parent = null;
      return;
    }
    const parent = this.#node(leaf.parent!);
    if (parent.type !== "branch") {
      throw new Error(
        `dynamic AABB tree leaf ${leaf.id} parent ${parent.id} is not a branch`,
      );
    }
    let sibling_id: number;
    if (parent.left === leaf.id) sibling_id = parent.right;
    else if (parent.right === leaf.id) sibling_id = parent.left;
    else {
      throw new Error(
        `dynamic AABB tree parent ${parent.id} does not reference leaf ${leaf.id}`,
      );
    }
    const sibling = this.#node(sibling_id);
    const grandparent_id = parent.parent;
    if (grandparent_id === null) {
      this.#root = sibling.id;
      sibling.parent = null;
    } else {
      const grandparent = this.#node(grandparent_id);
      if (grandparent.type !== "branch") {
        throw new Error(
          `dynamic AABB tree grandparent ${grandparent.id} is not a branch`,
        );
      }
      if (grandparent.left === parent.id) grandparent.left = sibling.id;
      else if (grandparent.right === parent.id) grandparent.right = sibling.id;
      else {throw new Error(
          `grandparent ${grandparent.id} does not reference parent ${parent.id}`,
        );}
      sibling.parent = grandparent.id;
    }
    this.#nodes.delete(parent.id);
    leaf.parent = null;
    if (grandparent_id !== null) this.#refit(grandparent_id);
  }

  #refit(start: number): void {
    let node_id: number | null = start;
    while (node_id !== null) {
      const node = this.#node(node_id);
      if (node.type === "leaf") {
        node_id = node.parent;
        continue;
      }
      const left = this.#node(node.left);
      const right = this.#node(node.right);
      node.bounds = aabb_union(left.bounds, right.bounds);
      node.height = 1 + Math.max(left.height, right.height);
      node_id = node.parent;
    }
  }
}
