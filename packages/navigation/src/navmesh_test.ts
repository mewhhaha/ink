import { aabb } from "@ink/geometry/shapes.ts";
import { vec3 } from "@ink/math/vector.ts";
import { assertEquals } from "@std/assert";
import { navigation_obstacle_id, navigation_tile_id } from "./identity.ts";
import { NavigationMesh } from "./navmesh.ts";
import { navigation_profile, tile_input } from "./test_support.ts";
import { build_navigation_tile } from "./tile.ts";

Deno.test("dynamic obstacle overlays remove covered polygons immediately", () => {
  const profile = navigation_profile();
  const mesh = new NavigationMesh({ profile });
  const built = build_navigation_tile(tile_input("tile", 0, 0), profile);
  if (built.type !== "ready") throw new Error(built.type);
  mesh.publish(built.tile);
  const revision = mesh.revision;
  mesh.set_obstacles([{
    id: navigation_obstacle_id("crate"),
    revision: 1,
    bounds: aabb(vec3(0, -1, 0), vec3(1, 2, 1)),
  }]);
  assertEquals(mesh.revision, revision + 1);
  assertEquals(mesh.snapshot().polygons.length, 3);
});

Deno.test("obstacle rebuilds are bounded, atomic, and cancellable", async () => {
  const profile = navigation_profile();
  const mesh = new NavigationMesh({ profile });
  const sources = [tile_input("west", 0, 0), tile_input("east", 1, 0)];
  for (const source of sources) {
    const built = build_navigation_tile(source, profile);
    if (built.type !== "ready") throw new Error(built.type);
    mesh.publish(built.tile);
  }
  const obstacle = {
    id: navigation_obstacle_id("gate"),
    revision: 1,
    bounds: aabb(vec3(1, -1, 0), vec3(3, 2, 2)),
  };
  const rebuilt = await mesh.rebuild_obstacles(sources, [obstacle], {
    maximum_tiles: 1,
  });
  assertEquals(rebuilt.type, "rebuilt");
  if (rebuilt.type === "rebuilt") {
    assertEquals(rebuilt.rebuilt, [navigation_tile_id("east")]);
    assertEquals(rebuilt.deferred, [navigation_tile_id("west")]);
  }

  const cleared = await mesh.rebuild_obstacles(sources, [], {
    maximum_tiles: 2,
  });
  assertEquals(cleared.type, "rebuilt");
  assertEquals(mesh.snapshot().polygons.length, 8);

  const cancellation = new AbortController();
  cancellation.abort();
  assertEquals(
    (await mesh.rebuild_obstacles(sources, [obstacle], {
      maximum_tiles: 2,
      signal: cancellation.signal,
    })).type,
    "cancelled",
  );
});
