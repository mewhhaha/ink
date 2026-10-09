import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { mat4 } from "@ink/geometry";
import {
  type Atlas,
  type Catalog,
  defineSchema,
  parseAtlas,
  sceneToWorld,
  standard,
} from "@ink/schema";
import {
  extractScene,
  fontAtlas,
  layout2d,
  layoutText,
  pick2d,
  sceneGizmos2d,
} from "./mod.ts";
import { signedDistance } from "./font.ts";

const schema = defineSchema({
  components: {
    transform: standard.transform,
    camera: standard.camera,
    ...standard.components2d,
  },
  resources: {},
  events: {},
  actions: {},
  messages: { score: "Score {0}" },
});

const atlas: Atlas = parseAtlas(
  JSON.stringify({
    image: "tiles.png",
    grid: { cell: [16, 16], columns: 4, rows: 1 },
    names: { ground: 0, plank: 1 },
    animations: { spin: { frames: ["ground", "plank"], fps: 4 } },
    tiles: { ground: "solid" },
  }),
  "tiles.atlas.json",
);

const catalog: Catalog = {
  assets: {
    mesh: [],
    texture: ["tiles.png"],
    sound: [],
    atlas: ["tiles.atlas.json"],
  },
};

/** A stand-in asset store: the atlas and a 64 x 16 texture, no GPU. */
const assets = {
  atlas: (path: string) => path === "tiles.atlas.json" ? atlas : undefined,
  textureSize: (path: string): [number, number] | undefined =>
    path === "tiles.png" ? [64, 16] : undefined,
  preload: () => {},
};

const extract = (entities: unknown[]) =>
  extractScene(
    sceneToWorld(schema, { ink: 1, entities } as never, catalog).world,
    catalog,
    { text: (_entity, message, a) => message ? `Score ${a}` : "named" },
  );

Deno.test("sprites resolve atlas frames, animations and pivots", () => {
  const scene = extract([
    {
      id: 1,
      components: {
        transform: { position: [4, 2, 0] },
        sprite: {
          atlas: "tiles.atlas.json",
          frame: 2,
          pivot: [0, 0],
          pixels_per_unit: 16,
        },
      },
    },
    {
      id: 2,
      components: {
        transform: { position: [0, 0, 0] },
        sprite: {
          atlas: "tiles.atlas.json",
          anim: 1,
          anim_time: 0.3,
          layer: 1,
        },
      },
    },
  ]);
  const items = layout2d(scene, assets);
  assertEquals(items.length, 2);
  const first = items[0];
  assert(first.kind === "sprite");
  // Frame 2 is the second cell: a quarter of the 64 pixel wide image.
  assertEquals(first.rect, [0.25, 0, 0.25, 1]);
  // 16 pixels at 16 per unit is one unit, placed with its corner at (4, 2).
  assertEquals(Array.from(mat4.transformPoint(first.matrix, [0, 0, 0])), [
    4,
    2,
    0,
  ]);
  assertEquals(Array.from(mat4.transformPoint(first.matrix, [1, 1, 0])), [
    5,
    3,
    0,
  ]);
  // The animation (4 fps, 0.3 s) is on its second frame.
  const second = items[1];
  assert(second.kind === "sprite");
  assertEquals(second.rect[0], 0.25);
});

Deno.test("2D content sorts by layer, then y, then world order", () => {
  const sprite = (id: number, y: number, extra = {}) => ({
    id,
    components: {
      transform: { position: [0, y, 0] },
      sprite: { atlas: "tiles.atlas.json", frame: 1, ...extra },
    },
  });
  const scene = extract([
    sprite(1, 0, { layer: 2 }),
    sprite(2, 5, { y_sort: true }),
    sprite(3, 1, { y_sort: true }),
    sprite(4, 9),
  ]);
  // Layer 0: the y-sorted pair (lower y in front, so drawn last) and the
  // plain one by world order; layer 2 on top.
  assertEquals(layout2d(scene, assets).map((i) => i.entity), [4, 2, 3, 1]);
});

Deno.test("items wait for their atlas and their image", () => {
  const scene = extract([{
    id: 1,
    components: { sprite: { atlas: "tiles.atlas.json" } },
  }]);
  assertEquals(
    layout2d(scene, { ...assets, atlas: () => undefined }).length,
    0,
  );
  assertEquals(
    layout2d(scene, { ...assets, textureSize: () => undefined }).length,
    0,
  );
});

Deno.test("tile maps become one quad with per-tile rectangles", () => {
  const scene = extract([{
    id: 1,
    components: {
      transform: { position: [2, 1, 0] },
      tilemap: {
        tileset: "tiles.atlas.json",
        width: 3,
        height: 2,
        cell: [2, 2],
        cells: [1, 0, 2],
      },
    },
  }]);
  const [map] = layout2d(scene, assets);
  assert(map.kind === "tilemap");
  assertEquals(map.data.length, 6, "short data is padded");
  // The whole map is 6 x 4 units from its corner.
  assertEquals(Array.from(mat4.transformPoint(map.matrix, [1, 1, 0])), [
    8,
    5,
    0,
  ]);
  assertEquals(Array.from(map.rects.slice(8, 12)), [0.25, 0, 0.25, 1]);
  assertEquals(map.flags[1], 1);
  assert(scene.bounds, "tile maps count toward the scene bounds");
  const picked = pick2d([map], {
    origin: [4.5, 3.5, 5],
    direction: [0, 0, -1],
  });
  assertEquals(picked?.cell, [1, 1]);
  assertEquals(picked?.entity, 1);
});

Deno.test("text takes its string from messages or the entity's name", () => {
  const scene = extract([
    { id: 1, components: { text: { message: "score", a: 7, size: 2 } } },
    { id: 2, components: { text: {} } },
  ]);
  assertEquals(scene.texts?.map((t) => t.text), ["Score 7", "named"]);
  const items = layout2d(scene, assets);
  assert(items.every((i) => i.kind === "text"));
  const first = items[0];
  assert(first.kind === "text");
  assertEquals(first.glyphs.length, "Score7".length + 0, "spaces draw nothing");
});

Deno.test("text layout aligns, centres and advances by the font", () => {
  const left = layoutText("AB", 8, "left");
  const centre = layoutText("AB", 8, "center");
  const right = layoutText("AB", 8, "right");
  // 8 units per line is one unit per font pixel: two glyphs advance 6 and
  // occupy 11 pixels.
  assertEquals(left.width, 11);
  assertAlmostEquals(left.glyphs[1].x - left.glyphs[0].x, 6);
  assertAlmostEquals(centre.glyphs[0].x - left.glyphs[0].x, -5.5);
  assertAlmostEquals(right.glyphs[0].x - left.glyphs[0].x, -11);
  assertEquals(layoutText("a\nb", 1, "left").height, 2);
});

Deno.test("the font is a signed distance field with a clean edge", () => {
  const atlas = fontAtlas();
  const again = fontAtlas();
  assert(atlas === again, "built once");
  const g = atlas.glyph("I");
  const x0 = Math.round(g.u * atlas.width), y0 = Math.round(g.v * atlas.height);
  const w = Math.round(g.w * atlas.width), h = Math.round(g.h * atlas.height);
  let inside = 0, outside = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = atlas.data[((y0 + y) * atlas.width + x0 + x) * 4];
      if (v > 160) inside++;
      if (v < 96) outside++;
    }
  }
  assert(
    inside > 200 && outside > inside,
    `inside ${inside}, outside ${outside}`,
  );
  // The distance field of a single pixel: 0.5 at its border.
  const d = signedDistance(new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 0]), 3, 3);
  assertAlmostEquals(d[4], 0.5);
  assertAlmostEquals(d[3], -0.5);
  assertAlmostEquals(d[0], -(Math.SQRT2 - 0.5));
});

Deno.test("selected 2D items and lights get editor outlines", () => {
  const scene = extract([
    {
      id: 1,
      components: {
        transform: { position: [1, 1, 0] },
        sprite: { atlas: "tiles.atlas.json", frame: 1 },
      },
    },
    {
      id: 2,
      components: {
        transform: { position: [5, 5, 0] },
        light2d: { kind: "lamp", radius: 3 },
      },
    },
  ]);
  const none = sceneGizmos2d(scene, assets, {});
  const both = sceneGizmos2d(scene, assets, { selection: [1, 2] });
  // A cross for the lamp; outlines of the sprite and the radius when selected.
  assertEquals(none.length, 2);
  assert(both.length > 40);
});
