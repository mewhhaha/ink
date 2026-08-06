import { aabb } from "@ink/geometry/shapes.ts";
import { vec3 } from "@ink/math/vector.ts";
import { update_crowd } from "./crowd.ts";
import { navigation_agent_id, navigation_obstacle_id } from "./identity.ts";
import {
  estimate_navigation_snapshot_bytes,
  NavigationMesh,
} from "./navmesh.ts";
import { find_navigation_path, repair_navigation_corridor } from "./query.ts";
import { ground_area, navigation_profile, tile_input } from "./test_support.ts";
import { build_navigation_tile } from "./tile.ts";

const profile = navigation_profile();
const large_input = tile_input("large", 0, 0, { width: 32, depth: 32 });
const built_large = build_navigation_tile(large_input, profile);
if (built_large.type !== "ready") throw new Error(built_large.type);
const mesh = new NavigationMesh({ profile });
mesh.publish(built_large.tile);
const snapshot = mesh.snapshot();
const query_options = {
  profile,
  areas: new Map([[ground_area.id, ground_area]]),
  maximum_snap_distance: 1,
  maximum_visited: 2_000,
  allow_partial: false,
};
const start = vec3(0.5, 0, 0.5);
const goal = vec3(31.5, 0, 31.5);
const initial_path = find_navigation_path(snapshot, start, goal, query_options);
if (initial_path.type !== "complete") throw new Error(initial_path.type);

Deno.bench("bake a 32-by-32 navigation tile", () => {
  const result = build_navigation_tile(large_input, profile);
  if (result.type !== "ready" || result.tile.polygons.length !== 1_024) {
    throw new Error("navigation bake benchmark produced an invalid tile");
  }
});

const rebuild_mesh = new NavigationMesh({ profile });
rebuild_mesh.publish(built_large.tile);
const rebuild_obstacle = {
  id: navigation_obstacle_id("benchmark-obstacle"),
  revision: 1,
  bounds: aabb(vec3(8, -1, 8), vec3(24, 2, 24)),
};

Deno.bench("rebuild one 32-by-32 tile for a dynamic obstacle", async () => {
  const result = await rebuild_mesh.rebuild_obstacles(
    [large_input],
    [rebuild_obstacle],
    { maximum_tiles: 1 },
  );
  if (result.type !== "rebuilt") throw new Error(result.type);
});

Deno.bench("account retained memory for a 1,024-polygon snapshot", () => {
  const bytes = estimate_navigation_snapshot_bytes(snapshot);
  if (bytes <= 0) throw new Error("navigation memory estimate is empty");
});

Deno.bench("query a diagonal path across 1,024 polygons", () => {
  const result = find_navigation_path(snapshot, start, goal, query_options);
  if (result.type !== "complete") throw new Error(result.type);
});

Deno.bench("repair a 63-polygon corridor", () => {
  const result = repair_navigation_corridor(
    snapshot,
    initial_path.path.corridor,
    start,
    goal,
    query_options,
  );
  if (result.type !== "repaired") throw new Error(result.type);
});

const crowd = Array.from({ length: 500 }, (_, index) => ({
  id: navigation_agent_id(`agent-${index.toString().padStart(3, "0")}`),
  position: vec3(index % 25, 0, Math.floor(index / 25)),
  velocity: vec3(0, 0, 0),
  path: [vec3(31, 0, 31)],
  profile,
}));

Deno.bench("update deterministic steering for 500 crowd agents", () => {
  const result = update_crowd(snapshot, crowd, {
    delta_seconds: 1 / 60,
    neighbor_distance: 2,
    obstacle_distance: 1,
  });
  if (result.type !== "ready" || result.outputs.length !== 500) {
    throw new Error("navigation crowd benchmark lost agents");
  }
});
