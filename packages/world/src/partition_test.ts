import { asset_id } from "@ink/assets/identity.ts";
import { aabb } from "@ink/geometry/shapes.ts";
import { vec3 } from "@ink/math/vector.ts";
import { assertEquals, assertThrows } from "@std/assert";
import {
  cell_id,
  chunk_coordinate,
  global_position,
  global_to_local,
  level_id,
  local_origin,
  local_to_global,
  world_id,
} from "./identity.ts";
import {
  create_authored_partition,
  create_grid_partition,
} from "./experimental/partition.ts";
import { create_spatial_demand } from "./experimental/streaming.ts";

Deno.test("global coordinates normalize negative offsets and round trip locally", () => {
  const position = global_position(0, 0, vec3(-1, 7, -11), 10);
  assertEquals(position, {
    cell_x: -1,
    cell_z: -2,
    offset: vec3(9, 7, 9),
  });
  const origin = local_origin(global_position(-3, 4, vec3(2, 1, 8), 10));
  const local = global_to_local(position, origin, 10);
  assertEquals(local_to_global(local, origin, 10), position);
});

Deno.test("grid partition locates negative cells and chooses deterministic LOD demand", () => {
  const world = world_id("world");
  const level = level_id("surface");
  const cells = [
    {
      coordinate: chunk_coordinate(-1, 0, 0),
      scene_asset: asset_id<"scene">("near"),
      estimated_bytes: 10,
    },
    {
      coordinate: chunk_coordinate(-1, 0, 1),
      scene_asset: asset_id<"scene">("far"),
      estimated_bytes: 5,
    },
    {
      coordinate: chunk_coordinate(0, 0, 0),
      scene_asset: asset_id<"scene">("neighbor"),
      estimated_bytes: 10,
    },
  ];
  const partition = create_grid_partition({
    world_id: world,
    level_id: level,
    cell_size: 10,
    cells,
  });
  const focus = global_position(-1, 0, vec3(5, 0, 5), 10);
  assertEquals(
    partition.locate(focus).map(({ coordinate }) => coordinate?.lod),
    [
      0,
      1,
    ],
  );
  assertEquals(
    create_spatial_demand(partition, {
      focus,
      visible_distance: 1,
      prefetch_distance: 20,
      lod_distances: [8],
    }).map(({ cell_id: id, priority }) => ({ id, priority })),
    [
      { id: cell_id("surface:-1:0:0"), priority: "blocking" },
      { id: cell_id("surface:0:0:0"), priority: "background" },
    ],
  );
});

Deno.test("authored partitions validate portal targets before exposure", () => {
  assertThrows(
    () =>
      create_authored_partition({
        world_id: world_id("world"),
        level_id: level_id("interior"),
        coordinate_cell_size: 100,
        cells: [{
          id: cell_id("room-a"),
          bounds: aabb(vec3(0, 0, 0), vec3(10, 10, 10)),
          scene_asset: asset_id<"scene">("room-a"),
          estimated_bytes: 10,
          portals: [{ id: "door", to: cell_id("missing") }],
        }],
      }),
    Error,
    'portal "door" targets missing cell "missing"',
  );
});

Deno.test("authored partitions reject duplicate portal identities", () => {
  assertThrows(
    () =>
      create_authored_partition({
        world_id: world_id("world"),
        level_id: level_id("interior"),
        coordinate_cell_size: 100,
        cells: [
          {
            id: cell_id("room-a"),
            bounds: aabb(vec3(0, 0, 0), vec3(10, 10, 10)),
            scene_asset: asset_id<"scene">("room-a"),
            estimated_bytes: 10,
            portals: [
              { id: "door", to: cell_id("room-b") },
              { id: "door", to: cell_id("room-b") },
            ],
          },
          {
            id: cell_id("room-b"),
            bounds: aabb(vec3(10, 0, 0), vec3(20, 10, 10)),
            scene_asset: asset_id<"scene">("room-b"),
            estimated_bytes: 10,
          },
        ],
      }),
    Error,
    'cell "room-a" repeats portal "door"',
  );
});
