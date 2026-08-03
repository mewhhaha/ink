import { assertEquals, assertThrows } from "@std/assert";
import { expand_isometric_tilemap } from "./src/isometric_tilemap.ts";

Deno.test("isometric tilemaps expand terrain roads and details", () => {
  const objects = expand_isometric_tilemap({
    columns: 2n,
    detail_scale: 30n,
    first_object_id: 10n,
    ground_mesh: 5n,
    origin_y: -100n,
    road_texture: 9n,
    rows: 2n,
    secondary_texture: 1n,
    tile_half_height: 4n,
    tile_half_width: 8n,
    tile_scale: 20n,
    texture_scale_x: 350_000n,
    texture_scale_y: 400_000n,
    variation_seed: 137n,
  }, [
    {
      terrain_texture: 0n,
      blend_edges: 0n,
      path_connections: -1n,
      detail_texture: -1n,
    },
    {
      terrain_texture: 1n,
      blend_edges: 4n,
      path_connections: 3n,
      detail_texture: 7n,
    },
    {
      terrain_texture: 0n,
      blend_edges: 0n,
      path_connections: -1n,
      detail_texture: 5n,
    },
    {
      terrain_texture: 1n,
      blend_edges: 0n,
      path_connections: 0n,
      detail_texture: -1n,
    },
  ]);

  assertEquals(objects.length, 8);
  assertEquals(
    objects.filter((object) => object.mesh === 5).map((object) => ({
      id: object.id,
      position: object.position,
      texture: object.texture,
      blend_edges: object.blend_edges,
    })),
    [
      { id: 10, position: [0, -100, 0], texture: 0, blend_edges: 0 },
      { id: 11, position: [8, -96, 0], texture: 1, blend_edges: 4 },
      { id: 12, position: [-8, -96, 0], texture: 0, blend_edges: 0 },
      { id: 13, position: [0, -92, 0], texture: 1, blend_edges: 0 },
    ],
  );
  assertEquals(
    objects.filter((object) => object.mesh === 6).map((object) => [
      object.id,
      object.path_connections,
    ]),
    [[15, 3], [17, 0]],
  );
  assertEquals(
    objects.filter((object) => object.mesh === 7).map((object) => [
      object.id,
      object.texture,
      object.scale,
    ]),
    [[19, 7, [30, 30, 30]], [20, 5, [30, 30, 30]]],
  );
});

Deno.test("isometric tilemaps reject malformed descriptors", () => {
  assertThrows(
    () =>
      expand_isometric_tilemap({
        columns: 2n,
        detail_scale: 30n,
        first_object_id: 0n,
        ground_mesh: 0n,
        origin_y: 0n,
        road_texture: 2n,
        rows: 2n,
        secondary_texture: 1n,
        tile_half_height: 4n,
        tile_half_width: 8n,
        tile_scale: 20n,
        texture_scale_x: 350_000n,
        texture_scale_y: 400_000n,
        variation_seed: 137n,
      }, [{
        terrain_texture: 0n,
        blend_edges: 0n,
        path_connections: -1n,
        detail_texture: -1n,
      }]),
    Error,
    "isometric tilemap 2x2 requires 4 descriptors, received 1",
  );
});
