import { assertEquals } from "@std/assert";
import { expand_isometric_component_layer } from "./src/isometric_component_layer.ts";

Deno.test("isometric component layers render matching component values", () => {
  const objects = expand_isometric_component_layer({
    blend_edges: 0n,
    color_blue: 850_000n,
    color_green: 900_000n,
    color_red: 920_000n,
    columns: 3n,
    connection_mode: 1n,
    emissive: 0n,
    first_object_id: 100n,
    match_value: 7n,
    mesh: 1n,
    origin_y: -20n,
    rows: 2n,
    scale_x: 8n,
    scale_y: 8n,
    scale_z: 8n,
    secondary_texture: -1n,
    surface_mode: 1n,
    texture: 2n,
    texture_scale_x: 700_000n,
    texture_scale_y: 700_000n,
    tile_half_height: 5n,
    tile_half_width: 10n,
    variation_seed: 0n,
    z: 3n,
  }, [7n, 7n, undefined, 0n]);

  assertEquals(
    objects.map((object) => ({
      id: object.id,
      position: object.position,
      path_connections: object.path_connections,
      texture: object.texture,
    })),
    [
      {
        id: 100,
        position: [0, -20, 3],
        path_connections: 1,
        texture: 2,
      },
      {
        id: 101,
        position: [10, -15, 3],
        path_connections: 2,
        texture: 2,
      },
    ],
  );
});
