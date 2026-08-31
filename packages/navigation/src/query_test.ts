import { vec3 } from "@ink/math/vector.ts";
import { assertEquals } from "@std/assert";
import { navigation_area_id, off_mesh_link_id } from "./identity.ts";
import { NavigationMesh, type NavigationSnapshot } from "./navmesh.ts";
import type { NavigationPathOptions } from "./query.ts";
import {
  find_navigation_path,
  navigation_raycast,
  navigation_reachability,
  nearest_navigation_point,
  repair_navigation_corridor,
} from "./query.ts";
import {
  grid_geometry,
  ground_area,
  navigation_profile,
  tile_input,
  water_area,
} from "./experimental/test_support.ts";
import {
  build_navigation_tile,
  type NavigationTile,
  type NavigationTileInput,
} from "./tile.ts";

function built(
  input: NavigationTileInput,
  profile = navigation_profile(),
): NavigationTile {
  const result = build_navigation_tile(input, profile);
  if (result.type !== "ready") throw new Error(result.type);
  return result.tile;
}

function query_options(
  profile = navigation_profile(),
): NavigationPathOptions {
  return {
    profile,
    areas: new Map([
      [ground_area.id, ground_area],
      [water_area.id, water_area],
    ]),
    maximum_snap_distance: 0.5,
    maximum_visited: 1_000,
    allow_partial: false,
  };
}

Deno.test("path search crosses deterministic tile seams and funnel-smooths the corridor", () => {
  const profile = navigation_profile();
  const mesh = new NavigationMesh({ profile });
  mesh.publish(built(tile_input("west", 0, 0), profile));
  mesh.publish(built(tile_input("east", 1, 0), profile));
  const snapshot = mesh.snapshot();
  const result = find_navigation_path(
    snapshot,
    vec3(0.2, 0, 0.5),
    vec3(3.8, 0, 0.5),
    query_options(profile),
  );
  if (result.type !== "complete") throw new Error(result.type);
  assertEquals(result.path.corridor.length, 4);
  assertEquals(result.path.points, [vec3(0.2, 0, 0.5), vec3(3.8, 0, 0.5)]);
  assertEquals(
    navigation_raycast(snapshot, vec3(0.2, 0, 0.5), vec3(3.8, 0, 0.5))
      .type,
    "clear",
  );
});

Deno.test("raycasts reject unsafe sample counts instead of entering an unbounded loop", () => {
  const profile = navigation_profile();
  const mesh = new NavigationMesh({ profile });
  mesh.publish(built(tile_input("tiny-cells", 0, 0), profile));
  const snapshot = mesh.snapshot();
  const malformed = {
    ...snapshot,
    tiles: snapshot.tiles.map((tile) => ({
      ...tile,
      cell_size: Number.MIN_VALUE,
    })),
  } as NavigationSnapshot;
  assertEquals(
    navigation_raycast(malformed, vec3(0, 0, 0), vec3(1, 0, 0)).type,
    "unavailable",
  );
});

Deno.test("A star chooses the lower-cost area corridor and reports its work", () => {
  const profile = navigation_profile({
    area_costs: new Map([[water_area.id, 10]]),
  });
  const mesh = new NavigationMesh({ profile });
  const input = tile_input("costs", 0, 0, {
    width: 3,
    depth: 2,
    areas: [
      ground_area.id,
      water_area.id,
      ground_area.id,
      ground_area.id,
      ground_area.id,
      ground_area.id,
    ],
  });
  mesh.publish(built(input, profile));
  const result = find_navigation_path(
    mesh.snapshot(),
    vec3(0.5, 0, 0.5),
    vec3(2.5, 0, 0.5),
    query_options(profile),
  );
  if (result.type !== "complete") throw new Error(result.type);
  assertEquals(result.path.corridor.length, 5);
  assertEquals(result.path.total_cost, 4);
  assertEquals(result.path.open_set_expansions > 0, true);
});

Deno.test("streamed tile removal yields partial and stale paths without dangling polygons", () => {
  const profile = navigation_profile();
  const mesh = new NavigationMesh({ profile });
  mesh.publish(built(tile_input("west", 0, 0), profile));
  mesh.publish(built(tile_input("east", 1, 0), profile));
  const previous = find_navigation_path(
    mesh.snapshot(),
    vec3(0.2, 0, 0.5),
    vec3(3.8, 0, 0.5),
    query_options(profile),
  );
  if (previous.type !== "complete") throw new Error(previous.type);
  const old_revision = previous.path.revision;
  mesh.remove(tile_input("east", 1, 0).id);
  const snapshot = mesh.snapshot();
  assertEquals(
    snapshot.polygons.flatMap(({ connections }) => connections).some(({ to }) =>
      !snapshot.polygons.some(({ polygon }) => polygon.id === to)
    ),
    false,
  );
  const partial = find_navigation_path(
    snapshot,
    vec3(0.2, 0, 0.5),
    vec3(3.8, 0, 0.5),
    {
      ...query_options(profile),
      maximum_snap_distance: 0.1,
      allow_partial: true,
    },
  );
  assertEquals(partial.type, "partial");
  const stale = find_navigation_path(
    snapshot,
    vec3(0.2, 0, 0.5),
    vec3(1.8, 0, 0.5),
    { ...query_options(profile), expected_revision: old_revision },
  );
  assertEquals(stale, {
    type: "stale",
    expected_revision: old_revision,
    current_revision: snapshot.revision,
  });
  const repaired = repair_navigation_corridor(
    snapshot,
    previous.path.corridor,
    vec3(0.2, 0, 0.5),
    vec3(1.8, 0, 0.5),
    query_options(profile),
  );
  if (repaired.type !== "repaired") throw new Error(repaired.type);
  assertEquals(repaired.reused_polygons > 0, true);
});

Deno.test("off-mesh links connect islands without fabricating ordinary portals", () => {
  const profile = navigation_profile({
    area_costs: new Map([[water_area.id, 3]]),
  });
  const mesh = new NavigationMesh({ profile });
  const link = {
    id: off_mesh_link_id("jump"),
    start: vec3(0.5, 0, 0.5),
    finish: vec3(2.5, 0, 0.5),
    cost: 2,
    direction: "bidirectional" as const,
    area: navigation_area_id("water"),
    enabled: true,
  };
  const input: NavigationTileInput = {
    ...tile_input("islands", 0, 0, {
      width: 3,
      depth: 1,
      geometry: [grid_geometry(1, 1), grid_geometry(1, 1, 2, 0)],
    }),
    links: [link],
  };
  mesh.publish(built(input, profile));
  const result = find_navigation_path(
    mesh.snapshot(),
    link.start,
    link.finish,
    query_options(profile),
  );
  if (result.type !== "complete") throw new Error(result.type);
  assertEquals(result.path.links, [off_mesh_link_id("jump")]);
  assertEquals(result.path.points, [link.start, link.finish]);
  assertEquals(result.path.total_cost, 8);
});

Deno.test("nearest-point, reachability, and raycast distinguish disconnected space", () => {
  const profile = navigation_profile();
  const mesh = new NavigationMesh({ profile });
  mesh.publish(built({
    ...tile_input("islands", 0, 0, {
      width: 3,
      depth: 1,
      geometry: [grid_geometry(1, 1), grid_geometry(1, 1, 2, 0)],
    }),
  }, profile));
  const snapshot = mesh.snapshot();
  assertEquals(
    nearest_navigation_point(snapshot, vec3(0.25, 0.2, 0.25), {
      maximum_distance: 1,
    }).type,
    "ready",
  );
  assertEquals(
    navigation_reachability(
      snapshot,
      vec3(0.5, 0, 0.5),
      vec3(2.5, 0, 0.5),
      query_options(profile),
    ).type,
    "unreachable",
  );
  assertEquals(
    navigation_raycast(
      snapshot,
      vec3(0.5, 0, 0.5),
      vec3(2.5, 0, 0.5),
    ).type,
    "blocked",
  );
});

Deno.test("path work limits return unavailable instead of claiming disconnection", () => {
  const profile = navigation_profile();
  const mesh = new NavigationMesh({ profile });
  mesh.publish(built(tile_input("limited", 0, 0), profile));
  const result = find_navigation_path(
    mesh.snapshot(),
    vec3(0.5, 0, 0.5),
    vec3(1.5, 0, 1.5),
    { ...query_options(profile), maximum_visited: 1 },
  );
  assertEquals(result.type, "unavailable");
  if (result.type === "unavailable") {
    assertEquals(result.reason.includes("work limit"), true);
  }
});
