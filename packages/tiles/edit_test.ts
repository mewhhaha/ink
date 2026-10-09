import { assertEquals } from "@std/assert";
import { parseAtlas } from "@ink/schema";
import {
  fillCells,
  lineCells,
  paint,
  rectCells,
  resizeCells,
  tileAt,
  type TileGrid,
} from "./edit.ts";

const grid = (width: number, height: number): TileGrid => ({
  width,
  height,
  cells: new Array(width * height).fill(0),
});

Deno.test("lines and rectangles cover their cells", () => {
  assertEquals(lineCells([0, 0], [3, 1]).length, 4);
  assertEquals(lineCells([2, 2], [2, 2]), [[2, 2]]);
  assertEquals(rectCells([1, 1], [3, 2]).length, 6);
  assertEquals(rectCells([3, 3], [1, 1], false).length, 8);
});

Deno.test("flood fill stays inside the region", () => {
  const g = grid(4, 3);
  g.cells[1] = 5;
  g.cells[5] = 5;
  g.cells[9] = 5;
  assertEquals(fillCells(g, [0, 0]).length, 3);
  assertEquals(fillCells(g, [2, 0]).length, 6);
  assertEquals(fillCells(g, [-1, 0]), []);
});

const atlas = parseAtlas(
  JSON.stringify({
    image: "t.png",
    grid: { cell: [16, 16], columns: 4, rows: 4 },
    names: Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`g${i}`, i]),
    ),
    autotile: {
      g: {
        connects: Array.from({ length: 16 }, (_, i) => `g${i}`),
        tiles: Array.from({ length: 16 }, (_, i) => `g${i}`),
      },
    },
  }),
  "t.atlas.json",
);

Deno.test("auto-tiling picks variants by neighbours and updates them", () => {
  const g = grid(5, 3);
  paint(g, [[1, 1], [2, 1], [3, 1]], 16, atlas, true);
  // Variant m is frame m + 1; bits are N=1, E=2, S=4, W=8.
  const mask = (x: number) => tileAt(g, x, 1) - 1;
  assertEquals(mask(1), 2);
  assertEquals(mask(2), 2 + 8);
  assertEquals(mask(3), 8);
  // Erasing the middle re-tiles its neighbours.
  paint(g, [[2, 1]], 0, atlas, true);
  assertEquals(tileAt(g, 2, 1), 0);
  assertEquals(mask(1), 0);
  assertEquals(mask(3), 0);
});

Deno.test("resizing keeps the bottom left", () => {
  const g = grid(2, 2);
  g.cells = [1, 2, 3, 4];
  assertEquals(resizeCells(g, 3, 1), [1, 2, 0]);
  assertEquals(resizeCells(g, 2, 3), [1, 2, 3, 4, 0, 0]);
});
