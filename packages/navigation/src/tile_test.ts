import type { MeshTopology } from "@ink/geometry/mesh.ts";
import { aabb } from "@ink/geometry/shapes.ts";
import { vec3 } from "@ink/math/vector.ts";
import { assertEquals } from "@std/assert";
import { agent_profile_id, navigation_obstacle_id } from "./identity.ts";
import { create_agent_profile } from "./profile.ts";
import {
  grid_geometry,
  ground_area,
  navigation_profile,
  tile_input,
} from "./test_support.ts";
import { build_navigation_tile } from "./tile.ts";

Deno.test("invalid agent profiles return evidence without entering the bake", () => {
  assertEquals(
    create_agent_profile({
      id: agent_profile_id("invalid"),
      radius: -1,
      height: 1.8,
      maximum_climb: 0.5,
      maximum_slope_degrees: 45,
      maximum_speed: 4,
      maximum_acceleration: 8,
      area_costs: new Map(),
    }),
    {
      type: "invalid_profile",
      reason:
        'agent profile "invalid" radius -1 must be nonnegative and finite',
    },
  );
  assertEquals(
    create_agent_profile({
      id: " invalid " as never,
      radius: 1,
      height: 1,
      maximum_climb: 0,
      maximum_slope_degrees: 45,
      maximum_speed: 1,
      maximum_acceleration: 1,
      area_costs: new Map(),
    }).type,
    "invalid_profile",
  );
});

Deno.test("tile bake produces voxel, region, contour, polygon, and detail stages", () => {
  const result = build_navigation_tile(
    tile_input("tile", 0, 0),
    navigation_profile(),
  );
  if (result.type !== "ready") throw new Error(result.type);
  assertEquals(result.tile.diagnostics, {
    voxel_samples: 8,
    slope_rejected: 0,
    obstacle_rejected: 0,
    clearance_rejected: 0,
    regions: 1,
    polygons: 4,
  });
  assertEquals(result.tile.contours.length, 1);
  assertEquals(result.tile.contours[0].segments.length, 8);
  assertEquals(result.tile.details.length, 4);
  assertEquals(result.tile.details[0].triangles.length, 2);
});

Deno.test("slope and climb filtering preserve distinct traversable islands", () => {
  const slope = build_navigation_tile(
    tile_input("slope", 0, 0, {
      width: 1,
      depth: 1,
      geometry: [grid_geometry(1, 1, 0, 0, [0, 1, 0, 1])],
    }),
    navigation_profile({ maximum_slope_degrees: 30 }),
  );
  if (slope.type !== "ready") throw new Error(slope.type);
  assertEquals(slope.tile.polygons.length, 0);
  assertEquals(slope.tile.diagnostics.slope_rejected, 2);

  const step = build_navigation_tile(
    tile_input("step", 0, 0, {
      width: 2,
      depth: 1,
      geometry: [
        grid_geometry(1, 1),
        grid_geometry(1, 1, 1, 0, [1, 1, 1, 1]),
      ],
    }),
    navigation_profile({ maximum_climb: 0.5 }),
  );
  if (step.type !== "ready") throw new Error(step.type);
  assertEquals(step.tile.diagnostics.regions, 2);
  assertEquals(step.tile.polygons.map(({ portals }) => portals.length), [0, 0]);
});

Deno.test("clearance field removes passages narrower than the agent diameter", () => {
  const input = tile_input("passage", 0, 0, { width: 5, depth: 5 });
  const areas = new Array(25).fill(ground_area.id);
  const geometry = [grid_geometry(5, 5)];
  const obstacles = [1, 3].map((column) => ({
    id: navigation_obstacle_id(`wall-${column}`),
    revision: 1,
    bounds: aabb(vec3(column, -1, 0), vec3(column + 1, 2, 5)),
  }));
  const narrow = build_navigation_tile(
    { ...input, geometry, areas, obstacles },
    navigation_profile({ radius: 0.6 }),
  );
  if (narrow.type !== "ready") throw new Error(narrow.type);
  assertEquals(
    narrow.tile.polygons.some(({ center }) => center.x === 2.5),
    false,
  );
});

Deno.test("malformed source geometry returns the affected tile identity", () => {
  const malformed = {
    positions: [vec3(0, 0, 0), vec3(1, 0, 0), vec3(2, 0, 0)],
    indices: [0, 1, 2],
    texture_coordinates: null,
    triangle_count: 1,
  } as unknown as MeshTopology;
  const result = build_navigation_tile(
    tile_input("broken", 0, 0, {
      width: 1,
      depth: 1,
      geometry: [malformed],
    }),
    navigation_profile(),
  );
  assertEquals(result.type, "malformed_geometry");
  if (result.type === "malformed_geometry") {
    assertEquals(result.tile_id, "broken");
    assertEquals(result.reason.includes("zero area"), true);
  }
});

Deno.test("tile bake rejects unsafe derived cell counts before allocation", () => {
  const result = build_navigation_tile({
    ...tile_input("oversized", 0, 0),
    width: Number.MAX_SAFE_INTEGER,
    depth: 2,
  }, navigation_profile());
  assertEquals(result.type, "malformed_geometry");
  if (result.type === "malformed_geometry") {
    assertEquals(result.reason.includes("exceed a safe cell count"), true);
  }
});
