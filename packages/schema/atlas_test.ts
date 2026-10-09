import { assertEquals, assertThrows } from "@std/assert";
import {
  animationFrame,
  AtlasError,
  atlasInfo,
  autotileMask,
  defineSchema,
  generateBlot,
  parseAtlas,
  standard,
  TILE_ONEWAY,
  TILE_SOLID,
} from "./mod.ts";

const text = JSON.stringify({
  ink: 1,
  image: "../img/tiles.png",
  normals: "../img/tiles_n.png",
  grid: { cell: [16, 16], columns: 2, rows: 2, margin: 1, spacing: 2 },
  names: { ground: 0, plank: 1 },
  frames: { hero: [0, 40, 12, 20] },
  animations: { run: { frames: ["ground", "hero"], fps: 10 } },
  tiles: { ground: ["solid"], plank: ["oneway", "ladder"] },
  autotile: {
    g: { tiles: Array.from({ length: 16 }, () => "ground") },
  },
});

Deno.test("an atlas names grid cells and free rectangles", () => {
  const atlas = parseAtlas(text, "sets/tiles.atlas.json");
  assertEquals(atlas.image, "img/tiles.png");
  assertEquals(atlas.normals, "img/tiles_n.png");
  assertEquals(
    atlas.frames.map((f) => f.name),
    ["ground", "plank", "cell_2", "cell_3", "hero"],
  );
  // Margin 1, spacing 2: the second column starts at 1 + 16 + 2.
  assertEquals(atlas.frames[1], { name: "plank", x: 19, y: 1, w: 16, h: 16 });
  assertEquals(atlas.frames[4], { name: "hero", x: 0, y: 40, w: 12, h: 20 });
  assertEquals(atlas.tiles[1], TILE_SOLID);
  assertEquals(atlas.tiles[2], TILE_ONEWAY | 4);
  assertEquals(atlas.animations[0].frames, [1, 5]);
  assertEquals(atlas.autotile.g.connects, [1]);
});

Deno.test("animations pick frames from time and loop or hold", () => {
  const atlas = parseAtlas(text, "tiles.atlas.json");
  assertEquals(animationFrame(atlas, 1, 0, 3), 1);
  assertEquals(animationFrame(atlas, 1, 0.11, 3), 5);
  assertEquals(animationFrame(atlas, 1, 0.25, 3), 1);
  assertEquals(animationFrame(atlas, 0, 9, 3), 3);
  atlas.animations[0].loop = false;
  assertEquals(animationFrame(atlas, 1, 9, 3), 5);
});

Deno.test("mistakes in an atlas file are explained", () => {
  const bad = (change: Record<string, unknown>) =>
    parseAtlas(JSON.stringify({ image: "a.png", ...change }), "x.atlas.json");
  assertThrows(() => parseAtlas("{", "x"), AtlasError, "invalid JSON");
  assertThrows(() => parseAtlas("{}", "x"), AtlasError, "image");
  assertThrows(
    () => bad({ grid: { cell: [0, 4], columns: 1, rows: 1 } }),
    AtlasError,
    "grid.cell",
  );
  assertThrows(
    () => bad({ frames: { Hero: [0, 0, 1, 1] } }),
    AtlasError,
    "lower_snake_case",
  );
  assertThrows(
    () => bad({ frames: { a: [0, 0, 1, 1] }, tiles: { a: ["floaty"] } }),
    AtlasError,
    "unknown tile flag",
  );
  assertThrows(
    () => bad({ frames: { a: [0, 0, 1, 1] }, tiles: { b: "solid" } }),
    AtlasError,
    "unknown frame",
  );
});

Deno.test("the neighbour mask sees the map edge as more of the same", () => {
  const cells = [
    0,
    1,
    0,
    1,
    1,
    1,
    0,
    1,
    0,
  ];
  const joins = new Set([1]);
  assertEquals(autotileMask(cells, 3, 3, 1, 1, joins), 15);
  // Top row, middle: north is the map edge (joins), south is tiled, east and
  // west are empty.
  assertEquals(autotileMask(cells, 3, 3, 1, 2, joins), 1 | 4);
});

Deno.test("Blot gets frame, animation and tile flag constants", () => {
  const schema = defineSchema({
    components: { sprite: standard.sprite },
    resources: {},
    events: {},
    actions: {},
  });
  const atlas = parseAtlas(text, "gfx/tiles.atlas.json");
  const blot = generateBlot(schema, {
    assets: {
      mesh: [],
      texture: [],
      sound: [],
      atlas: ["gfx/tiles.atlas.json"],
    },
    atlases: { "gfx/tiles.atlas.json": atlasInfo(atlas) },
  });
  for (
    const line of [
      "const atlas_gfx_tiles: U32 = 1",
      "const frame_gfx_tiles_ground: U32 = 1",
      "const frame_gfx_tiles_hero: U32 = 5",
      "const anim_gfx_tiles_run: U32 = 1",
      "const tileflags_gfx_tiles: Array U32 = #[0, 1, 6, 0, 0, 0]",
    ]
  ) {
    if (!blot.includes(line)) throw new Error(`missing: ${line}`);
  }
});
