import { vec3 } from "@ink/math/vector.ts";
import { assertEquals, assertThrows } from "@std/assert";
import { global_position } from "./identity.ts";
import {
  create_terrain,
  edit_terrain,
  mesh_terrain_chunk,
  sample_terrain,
} from "./terrain.ts";

function flat_terrain() {
  return create_terrain({
    origin: global_position(0, 0, vec3(0, 0, 0), 100),
    width: 5,
    depth: 5,
    spacing: 1,
    heights: new Float32Array(25),
    regions: [{
      id: "center",
      minimum_x: 1,
      minimum_z: 1,
      maximum_x: 3,
      maximum_z: 3,
    }],
  });
}

Deno.test("terrain sampling and edits produce immutable revised layers", () => {
  const terrain = flat_terrain();
  const edited = edit_terrain(terrain, [
    { type: "set_height", x: 2, z: 2, height: 4 },
    { type: "set_surface", x: 2, z: 2, surface: 7 },
    { type: "set_detail", x: 2, z: 2, detail: 0.5 },
    { type: "set_hole", x: 1, z: 1, hole: true },
  ], { chunk_quads: 4 });
  assertEquals(terrain.heights[12], 0);
  assertEquals(edited.terrain.revision, 1);
  assertEquals(edited.changed_chunks.map(({ x, z }) => [x, z]), [[0, 0]]);
  assertEquals(sample_terrain(edited.terrain, 2, 2), {
    type: "surface",
    height: 4,
    normal: vec3(0, 1, 0),
    surface: 7,
    detail: 0.5,
    hole: false,
    regions: ["center"],
  });
  assertEquals(sample_terrain(terrain, -0.1, 0), { type: "outside" });
});

Deno.test("terrain LOD seams share endpoints and skirts cover cracks", () => {
  const terrain = flat_terrain();
  const detailed = mesh_terrain_chunk(terrain, { x: 0, z: 0, lod: 0 }, {
    chunk_quads: 4,
    skirt_depth: 2,
  });
  const coarse = mesh_terrain_chunk(terrain, { x: 0, z: 0, lod: 1 }, {
    chunk_quads: 4,
    skirt_depth: 2,
  });
  assertEquals(detailed.seams.east[0], coarse.seams.east[0]);
  assertEquals(detailed.seams.east.at(-1), coarse.seams.east.at(-1));
  assertEquals(detailed.seam_strategy, "skirts");
  assertEquals(
    [...detailed.positions].some((value, index) =>
      index % 3 === 1 && value === -2
    ),
    true,
  );
});

Deno.test("terrain holes remove affected top-level triangles", () => {
  const terrain = edit_terrain(flat_terrain(), [
    { type: "set_hole", x: 1, z: 1, hole: true },
  ], { chunk_quads: 4 }).terrain;
  const complete = mesh_terrain_chunk(
    flat_terrain(),
    { x: 0, z: 0, lod: 0 },
    { chunk_quads: 4, skirt_depth: 1 },
  );
  const holed = mesh_terrain_chunk(terrain, { x: 0, z: 0, lod: 0 }, {
    chunk_quads: 4,
    skirt_depth: 1,
  });
  assertEquals(holed.indices.length, complete.indices.length - 6);
});

Deno.test("terrain descriptors reject duplicate authored regions", () => {
  assertThrows(
    () =>
      create_terrain({
        origin: global_position(0, 0, vec3(0, 0, 0), 10),
        width: 2,
        depth: 2,
        spacing: 1,
        heights: new Float32Array(4),
        regions: [
          {
            id: "town",
            minimum_x: 0,
            minimum_z: 0,
            maximum_x: 1,
            maximum_z: 1,
          },
          {
            id: "town",
            minimum_x: 0,
            minimum_z: 0,
            maximum_x: 1,
            maximum_z: 1,
          },
        ],
      }),
    Error,
    'terrain repeats region "town"',
  );
});
