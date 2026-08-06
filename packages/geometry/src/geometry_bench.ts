import { vec3 } from "@ink/math/vector.ts";
import { ray_aabb_intersection } from "./queries.ts";
import { aabb, ray } from "./shapes.ts";
import { build_static_bvh, ray_query_static_bvh } from "./static_bvh.ts";

const benchmark_entries = Array.from({ length: 4_096 }, (_, index) => {
  const x = index % 64;
  const y = Math.floor(index / 64);
  return {
    bounds: aabb(vec3(x * 2, y * 2, -1), vec3(x * 2 + 1, y * 2 + 1, 1)),
    payload: index,
  };
});
const benchmark_tree = build_static_bvh(benchmark_entries);
const benchmark_rays = Array.from(
  { length: 10_000 },
  (_, index) => ray(vec3(-10, index % 128, 0), vec3(1, 0, 0)),
);

Deno.bench("query 10,000 rays against a static BVH", () => {
  let candidates = 0;
  for (const cast of benchmark_rays) {
    candidates += ray_query_static_bvh(benchmark_tree, cast).length;
  }
  if (candidates === 0) {
    throw new Error("static BVH ray benchmark found no candidates");
  }
});

Deno.bench("build a static BVH with 4,096 bounds", () => {
  const tree = build_static_bvh(benchmark_entries);
  if (tree.root === null) {
    throw new Error("static BVH build benchmark produced no root");
  }
});

Deno.bench("intersect 10,000 rays with one AABB", () => {
  const bounds = benchmark_entries[0].bounds;
  let hits = 0;
  for (const cast of benchmark_rays) {
    if (ray_aabb_intersection(cast, bounds) !== null) hits++;
  }
  if (hits === 0) throw new Error("AABB ray benchmark found no hits");
});
