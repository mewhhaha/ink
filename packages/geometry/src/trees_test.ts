import { assertEquals, assertThrows } from "@std/assert";
import { vec3 } from "@ink/math/vector.ts";
import { DynamicAabbTree } from "./dynamic_tree.ts";
import { aabb_overlap } from "./queries.ts";
import { aabb, ray } from "./shapes.ts";
import {
  build_static_bvh,
  query_static_bvh,
  ray_query_static_bvh,
} from "./static_bvh.ts";

function indexed_bounds(index: number) {
  return aabb(vec3(index, 0, 0), vec3(index + 0.5, 1, 1));
}

Deno.test("static BVH queries return the same ordered candidates as exhaustive search", () => {
  const entries = Array.from({ length: 32 }, (_, index) => ({
    bounds: indexed_bounds(index),
    payload: index,
  }));
  const tree = build_static_bvh(entries, 2);
  const query = aabb(vec3(7.5, -1, -1), vec3(14, 2, 2));
  const exhaustive = entries
    .filter((entry) => aabb_overlap(entry.bounds, query) !== "disjoint")
    .map((entry) => entry.payload);
  assertEquals(query_static_bvh(tree, query), exhaustive);
  assertEquals(
    ray_query_static_bvh(tree, ray(vec3(-1, 0.5, 0.5), vec3(1, 0, 0)), 5),
    [0, 1, 2, 3, 4],
  );
});

Deno.test("static BVH construction is deterministic for ordered inputs", () => {
  const entries = Array.from({ length: 17 }, (_, index) => ({
    bounds: indexed_bounds((index * 7) % 17),
    payload: index,
  }));
  assertEquals(
    build_static_bvh(entries, 3).nodes,
    build_static_bvh(entries, 3).nodes,
  );
  assertThrows(
    () => build_static_bvh(entries, 0),
    Error,
    "maximum BVH leaf size must be a positive safe integer, received 0",
  );
});

Deno.test("dynamic tree insert update remove and query preserve stable handles", () => {
  const tree = new DynamicAabbTree<string>();
  const first = tree.insert(indexed_bounds(0), "first");
  const second = tree.insert(indexed_bounds(4), "second");
  assertEquals(tree.validate(), []);
  assertEquals(
    tree.query(aabb(vec3(-1, -1, -1), vec3(1, 2, 2))).map((match) =>
      match.payload
    ),
    ["first"],
  );
  tree.update(second, indexed_bounds(0.25));
  tree.replace(first, "replaced");
  assertEquals(
    tree.query(aabb(vec3(0, -1, -1), vec3(1, 2, 2))).map((match) =>
      match.payload
    ),
    ["replaced", "second"],
  );
  assertEquals(tree.remove(first), "replaced");
  assertEquals(tree.validate(), []);
  assertEquals(
    tree.query(aabb(vec3(0, -1, -1), vec3(1, 2, 2))).map((match) =>
      match.payload
    ),
    ["second"],
  );
  assertThrows(
    () => tree.remove(first),
    Error,
    `dynamic AABB tree handle ${first.id} does not exist`,
  );
});

Deno.test("dynamic tree churn matches exhaustive overlap queries", () => {
  const tree = new DynamicAabbTree<number>();
  const records = new Map<
    number,
    {
      bounds: ReturnType<typeof indexed_bounds>;
      handle: ReturnType<typeof tree.insert>;
    }
  >();
  for (let index = 0; index < 100; index++) {
    const bounds = indexed_bounds((index * 37) % 100);
    records.set(index, { bounds, handle: tree.insert(bounds, index) });
  }
  for (let index = 0; index < 100; index += 3) {
    const record = records.get(index)!;
    const bounds = indexed_bounds(index / 10);
    tree.update(record.handle, bounds);
    records.set(index, { ...record, bounds });
  }
  for (let index = 1; index < 100; index += 4) {
    tree.remove(records.get(index)!.handle);
    records.delete(index);
  }
  assertEquals(tree.validate(), []);
  for (let index = 0; index < 20; index++) {
    const query = aabb(vec3(index * 2, -1, -1), vec3(index * 2 + 3, 2, 2));
    const expected = [...records.entries()]
      .filter(([, record]) => aabb_overlap(record.bounds, query) !== "disjoint")
      .map(([payload]) => payload)
      .sort((left, right) =>
        records.get(left)!.handle.id - records.get(right)!.handle.id
      );
    assertEquals(tree.query(query).map((match) => match.payload), expected);
  }
});
