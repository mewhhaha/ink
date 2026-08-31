import { vec3 } from "@ink/math/vector.ts";
import { rigid_pose } from "@ink/physics/collision.ts";
import type { PhysicsMutationResult } from "@ink/physics/world.ts";
import { PhysicsWorld } from "@ink/physics/world.ts";
import { physics_world_id } from "@ink/physics/identity.ts";
import { capsule_shape } from "@ink/physics/shapes.ts";
import { assertEquals } from "@std/assert";
import { scene_id } from "@ink/scene/identity.ts";
import {
  cell_id,
  chunk_coordinate,
  global_position,
  local_origin,
} from "@ink/world/identity.ts";
import type { PartitionCell } from "@ink/world/experimental/partition.ts";
import { create_terrain } from "@ink/world/terrain.ts";
import {
  evaluate_navigation_characters,
  navigation_obstacles_from_physics,
  navigation_origin_shift_adapter,
  navigation_tile_input_from_terrain,
  type NavigationSceneSnapshot,
  WorldNavigationPublisher,
} from "./experimental/adapters.ts";
import { navigation_agent_id, navigation_tile_id } from "./identity.ts";
import { NavigationMesh } from "./navmesh.ts";
import {
  ground_area,
  navigation_profile,
  tile_input,
} from "./experimental/test_support.ts";
import { build_navigation_tile } from "./tile.ts";

function created<Id>(result: PhysicsMutationResult<Id>): Id {
  if (result.type !== "created") throw new Error(result.reason);
  return result.id;
}

Deno.test("terrain adapter preserves world origin and hole topology", () => {
  const terrain = create_terrain({
    origin: global_position(2, -1, vec3(3, 0, 4), 10),
    width: 3,
    depth: 3,
    spacing: 1,
    heights: new Float32Array(9),
    holes: new Uint8Array([0, 1, 0, 0]),
  });
  const input = navigation_tile_input_from_terrain(
    terrain,
    chunk_coordinate(0, 0),
    {
      id: navigation_tile_id("terrain"),
      chunk_quads: 2,
      cell_height: 0.1,
      area: ground_area.id,
      local_origin: local_origin(global_position(2, -1, vec3(0, 0, 0), 10)),
      world_cell_size: 10,
    },
  );
  assertEquals(input.origin, vec3(3, 0, 4));
  const result = build_navigation_tile(input, navigation_profile());
  if (result.type !== "ready") throw new Error(result.type);
  assertEquals(result.tile.polygons.length, 3);
});

Deno.test("world publisher ignores stale detach after a newer scene publication", async () => {
  const profile = navigation_profile();
  const mesh = new NavigationMesh({ profile });
  const cell = { id: cell_id("cell") } as unknown as PartitionCell;
  const publisher = new WorldNavigationPublisher({
    mesh,
    profile,
    source: {
      extract: (_cell, snapshot) => [{
        ...tile_input("cell-tile", 0, 0),
        source_revision: snapshot.revision,
      }],
    },
  });
  const first: NavigationSceneSnapshot = {
    id: scene_id("cell"),
    revision: 1,
    nodes: [],
  };
  const second: NavigationSceneSnapshot = { ...first, revision: 2 };
  await publisher.publish(cell, first);
  await publisher.publish(cell, second);
  publisher.detach(cell, first);
  assertEquals(
    mesh.snapshot().tiles.map(({ source_revision }) => source_revision),
    [2],
  );
  publisher.detach(cell, second);
  assertEquals(mesh.snapshot().tiles.length, 0);
});

Deno.test("origin adapter rebases navigation transactionally", () => {
  const profile = navigation_profile();
  const mesh = new NavigationMesh({ profile });
  const tile = build_navigation_tile(tile_input("tile", 0, 0), profile);
  if (tile.type !== "ready") throw new Error(tile.type);
  mesh.publish(tile.tile);
  const adapter = navigation_origin_shift_adapter(mesh);
  const revision = mesh.revision;
  const stage = adapter.stage({
    sequence: 1,
    previous: local_origin(global_position(0, 0, vec3(0, 0, 0), 10)),
    current: local_origin(global_position(1, 0, vec3(0, 0, 0), 10)),
    local_translation: vec3(-10, 0, 0),
  });
  if (stage instanceof Promise) {
    throw new Error("navigation origin stage is unexpectedly asynchronous");
  }
  stage.commit();
  assertEquals(mesh.snapshot().polygons[0].polygon.center.x, -9.5);
  stage.rollback();
  assertEquals(mesh.snapshot().polygons[0].polygon.center.x, 0.5);
  assertEquals(mesh.revision, revision);
});

Deno.test("physics adapter exposes obstacles and movement proposals without mutating bodies", () => {
  const world = new PhysicsWorld({
    id: physics_world_id("navigation"),
    fixed_step_seconds: 1 / 60,
  });
  const shape = created(world.create_shape(capsule_shape(0.5, 0.25)));
  const body = created(world.create_body({
    motion: "kinematic",
    pose: rigid_pose(vec3(2, 1, 3)),
  }));
  created(world.create_collider({ body, shape }));
  assertEquals(
    navigation_obstacles_from_physics(world, {
      motions: ["kinematic"],
      include_sensors: false,
    }).length,
    1,
  );
  const before = world.body_state(body)!.pose;
  const proposals = evaluate_navigation_characters(
    world,
    [{
      agent: navigation_agent_id("agent"),
      desired_velocity: vec3(1, 0, 0),
      target: vec3(4, 1, 3),
      neighbors: [],
      navigation_revision: 1,
    }],
    [{ agent: navigation_agent_id("agent"), body, shape }],
    {
      delta_seconds: 0.5,
      step_height: 0.3,
      maximum_slope_radians: Math.PI / 4,
      skin: 0.01,
      filter: { ignored_bodies: [body] },
    },
  );
  assertEquals(proposals[0].movement.displacement, vec3(0.5, 0, 0));
  assertEquals(world.body_state(body)!.pose, before);
});
