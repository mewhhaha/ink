/**
 * Pure tile map editing: lines, rectangles, flood fills and auto-tiling over
 * the `cells` of a standard `tilemap` component (row 0 is the bottom row).
 * Nothing here touches a session, so tools, tests and scripts share it.
 */
import { type Atlas, autotileMask } from "@ink/schema";

export interface TileGrid {
  width: number;
  height: number;
  cells: number[];
}

export type Cell = [x: number, y: number];

export const inside = (
  g: Pick<TileGrid, "width" | "height">,
  x: number,
  y: number,
) => x >= 0 && y >= 0 && x < g.width && y < g.height;

export function tileAt(g: TileGrid, x: number, y: number): number {
  return inside(g, x, y) ? g.cells[y * g.width + x] ?? 0 : 0;
}

/** A tile map's cells padded or cut to exactly width x height. */
export function conformCells(
  cells: readonly number[],
  width: number,
  height: number,
): number[] {
  const out = new Array<number>(width * height).fill(0);
  for (let i = 0; i < out.length && i < cells.length; i++) out[i] = cells[i];
  return out;
}

/** The cells on a straight line, both ends included (Bresenham). */
export function lineCells(a: Cell, b: Cell): Cell[] {
  const out: Cell[] = [];
  let [x, y] = a;
  const dx = Math.abs(b[0] - x), dy = -Math.abs(b[1] - y);
  const sx = x < b[0] ? 1 : -1, sy = y < b[1] ? 1 : -1;
  let error = dx + dy;
  for (;;) {
    out.push([x, y]);
    if (x === b[0] && y === b[1]) break;
    const e2 = 2 * error;
    if (e2 >= dy) {
      error += dy;
      x += sx;
    }
    if (e2 <= dx) {
      error += dx;
      y += sy;
    }
  }
  return out;
}

/** The cells of the rectangle between two corners, filled or just its outline. */
export function rectCells(a: Cell, b: Cell, filled = true): Cell[] {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  const out: Cell[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (filled || x === x0 || x === x1 || y === y0 || y === y1) {
        out.push([x, y]);
      }
    }
  }
  return out;
}

/** The connected cells (4-neighbourhood) holding the same tile as the start. */
export function fillCells(g: TileGrid, start: Cell, limit = 1 << 16): Cell[] {
  if (!inside(g, start[0], start[1])) return [];
  const target = tileAt(g, start[0], start[1]);
  const seen = new Uint8Array(g.width * g.height);
  const out: Cell[] = [];
  const stack: Cell[] = [start];
  while (stack.length && out.length < limit) {
    const [x, y] = stack.pop()!;
    if (!inside(g, x, y) || seen[y * g.width + x]) continue;
    seen[y * g.width + x] = 1;
    if (tileAt(g, x, y) !== target) continue;
    out.push([x, y]);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return out;
}

/** Write `tile` into the cells; returns how many changed. */
export function stamp(
  g: TileGrid,
  cells: readonly Cell[],
  tile: number,
): number {
  let changed = 0;
  for (const [x, y] of cells) {
    if (!inside(g, x, y)) continue;
    const i = y * g.width + x;
    if (g.cells[i] !== tile) {
      g.cells[i] = tile;
      changed++;
    }
  }
  return changed;
}

/** The auto-tile rule a tile belongs to, if any. */
export function autotileRule(atlas: Atlas | undefined, tile: number) {
  if (!atlas) return undefined;
  for (const rule of Object.values(atlas.autotile)) {
    if (rule.connects.includes(tile)) return rule;
  }
  return undefined;
}

/** Re-pick the variants of the cells and their four neighbours, so edges,
 * corners and grass follow the shape that was painted or erased. */
export function retile(
  g: TileGrid,
  cells: readonly Cell[],
  atlas: Atlas | undefined,
): void {
  if (!atlas) return;
  const touched = new Map<number, Cell>();
  for (const [x, y] of cells) {
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (inside(g, x + dx, y + dy)) {
        touched.set((y + dy) * g.width + x + dx, [x + dx, y + dy]);
      }
    }
  }
  // Decide every variant from the neighbourhood as it is now, then write.
  const next: [number, number][] = [];
  for (const [i, [x, y]] of touched) {
    const rule = autotileRule(atlas, g.cells[i]);
    if (!rule) continue;
    const mask = autotileMask(
      g.cells,
      g.width,
      g.height,
      x,
      y,
      new Set(rule.connects),
    );
    next.push([i, rule.tiles[mask]]);
  }
  for (const [i, tile] of next) g.cells[i] = tile;
}

/** Paint (or, with tile 0, erase) cells, auto-tiling when asked. */
export function paint(
  g: TileGrid,
  cells: readonly Cell[],
  tile: number,
  atlas?: Atlas,
  auto = true,
): number {
  const rule = auto ? autotileRule(atlas, tile) : undefined;
  const changed = stamp(g, cells, rule ? rule.tiles[15] : tile);
  if (auto && atlas) retile(g, cells, atlas);
  return changed;
}

/** The map resized to new dimensions, keeping the bottom-left corner. */
export function resizeCells(
  g: TileGrid,
  width: number,
  height: number,
): number[] {
  const out = new Array<number>(width * height).fill(0);
  for (let y = 0; y < Math.min(height, g.height); y++) {
    for (let x = 0; x < Math.min(width, g.width); x++) {
      out[y * width + x] = g.cells[y * g.width + x] ?? 0;
    }
  }
  return out;
}

/** Cell under a world point for a map placed by a world matrix with only
 * translation and scale (rotated maps are not supported by tile tools). */
export function cellAtPoint(
  matrix: ArrayLike<number>,
  cell: [number, number],
  point: [number, number, number],
): Cell {
  const sx = Math.hypot(matrix[0], matrix[1]) * cell[0] || 1;
  const sy = Math.hypot(matrix[4], matrix[5]) * cell[1] || 1;
  return [
    Math.floor((point[0] - matrix[12]) / sx),
    Math.floor((point[1] - matrix[13]) / sy),
  ];
}
