/**
 * Viewport tools for painting tile maps in an orthographic view:
 *
 *   paint (B)  drag to paint the brush tile; Shift draws straight lines,
 *              Alt picks the tile under the pointer
 *   erase (E)  drag to erase
 *   rect  (R)  drag a filled rectangle; Shift draws only its outline
 *   fill  (G)  flood fill the connected tiles under the pointer
 *   pick  (I)  take the tile under the pointer as the brush
 *
 * Every stroke is one session transaction: a single undo step that also works
 * on the live world while the game runs, so painting changes what is playing.
 */
import type { Mat4 } from "@ink/geometry";
import type { Line } from "@ink/render";
import type { Session, Transaction } from "@ink/core";
import type { Atlas, AtlasInfo, Catalog, RecordValue } from "@ink/schema";
import type { PointerInfo, ViewportContext, ViewportTool } from "@ink/react";
import {
  type Cell,
  cellAtPoint,
  fillCells,
  inside,
  lineCells,
  paint,
  rectCells,
  tileAt,
  type TileGrid,
} from "./edit.ts";
import { chooseLayer, tileBrush } from "./state.ts";

const YELLOW: [number, number, number, number] = [1, 0.85, 0.2, 1];
const CYAN: [number, number, number, number] = [0.3, 0.85, 1, 1];
const RED: [number, number, number, number] = [1, 0.35, 0.3, 0.9];

export interface MapRef {
  entity: number;
  matrix: Mat4;
  width: number;
  height: number;
  cell: [number, number];
  tileset: string | undefined;
}

/** The tile map an edit goes to: the chosen layer, the selected map, or the
 * first one in the world. */
export function activeMap(
  session: Session,
  matrices: ReadonlyMap<number, Mat4>,
  layer = tileBrush.get().layer,
): MapRef | null {
  const pick = chooseLayer(session.world.entities, session.selection, layer);
  if (!pick) return null;
  const t = pick.components.tilemap;
  const matrix = matrices.get(pick.id);
  if (!matrix) return null;
  const tileset = session.catalog.assets.atlas?.[Number(t.tileset) - 1];
  return {
    entity: pick.id,
    matrix,
    width: Number(t.width),
    height: Number(t.height),
    cell: (t.cell as [number, number]) ?? [1, 1],
    tileset,
  };
}

/** The catalog's view of an atlas as the `Atlas` the edit functions use. */
export function atlasOf(catalog: Catalog, path: string | undefined) {
  const info: AtlasInfo | undefined = path
    ? catalog.atlases?.[path]
    : undefined;
  if (!info) return undefined;
  return {
    image: info.image,
    frames: info.frames.map((name, i) => ({
      name,
      x: info.rects[i][0],
      y: info.rects[i][1],
      w: info.rects[i][2],
      h: info.rects[i][3],
    })),
    animations: [],
    tiles: info.tiles,
    autotile: info.autotile,
  } as Atlas;
}

/** Apply `change` to a map's cells as one transaction update. */
function edit(
  tx: Transaction | Session,
  label: string,
  entity: number,
  atlas: Atlas | undefined,
  change: (grid: TileGrid, atlas: Atlas | undefined) => void,
) {
  const recipe = (
    world: {
      entities: { id: number; components: Record<string, RecordValue> }[];
    },
  ) => {
    const e = world.entities.find((x) => x.id === entity);
    const t = e?.components.tilemap;
    if (!t) return;
    const grid: TileGrid = {
      width: Number(t.width),
      height: Number(t.height),
      cells: [...(t.cells as number[])],
    };
    while (grid.cells.length < grid.width * grid.height) grid.cells.push(0);
    change(grid, atlas);
    t.cells = grid.cells;
  };
  if ("update" in tx) tx.update(recipe as never);
  else tx.edit(label, recipe as never);
}

const footprint = (cell: Cell, size: number): Cell[] => {
  const out: Cell[] = [];
  const low = -Math.floor((size - 1) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out.push([cell[0] + low + x, cell[1] + low + y]);
    }
  }
  return out;
};

function cellOutline(
  map: MapRef,
  cells: readonly Cell[],
  color: Line["color"],
): Line[] {
  const lines: Line[] = [];
  const sx = Math.hypot(map.matrix[0], map.matrix[1]) * map.cell[0];
  const sy = Math.hypot(map.matrix[4], map.matrix[5]) * map.cell[1];
  const keys = new Set(cells.map(([x, y]) => `${x},${y}`));
  for (const [x, y] of cells) {
    const x0 = map.matrix[12] + x * sx, y0 = map.matrix[13] + y * sy;
    const z = map.matrix[14];
    const edge = (
      dx: number,
      dy: number,
      a: [number, number],
      b: [number, number],
    ) => {
      if (!keys.has(`${x + dx},${y + dy}`)) {
        lines.push({
          from: [a[0], a[1], z],
          to: [b[0], b[1], z],
          color,
          width: 2,
        });
      }
    };
    edge(0, -1, [x0, y0], [x0 + sx, y0]);
    edge(1, 0, [x0 + sx, y0], [x0 + sx, y0 + sy]);
    edge(0, 1, [x0 + sx, y0 + sy], [x0, y0 + sy]);
    edge(-1, 0, [x0, y0 + sy], [x0, y0]);
  }
  return lines;
}

interface Stroke {
  map: MapRef;
  atlas: Atlas | undefined;
  tx: Transaction;
  last: Cell;
  tile: number;
  erase: boolean;
}

function cellOf(
  ctx: ViewportContext,
  map: MapRef,
  e: PointerInfo,
): Cell | null {
  const point = ctx.planePoint(e.x, e.y, [
    map.matrix[12],
    map.matrix[13],
    map.matrix[14],
  ]);
  return point ? cellAtPoint(map.matrix, map.cell, point) : null;
}

/** Bounds of a map as outline lines, to show what is being edited. */
export function mapBounds(map: MapRef, color: Line["color"]): Line[] {
  const sx = Math.hypot(map.matrix[0], map.matrix[1]) * map.cell[0] * map.width;
  const sy = Math.hypot(map.matrix[4], map.matrix[5]) * map.cell[1] *
    map.height;
  const [x, y, z] = [map.matrix[12], map.matrix[13], map.matrix[14]];
  const c: [number, number, number][] = [[x, y, z], [x + sx, y, z], [
    x + sx,
    y + sy,
    z,
  ], [x, y + sy, z]];
  return c.map((from, i) => ({ from, to: c[(i + 1) % 4], color, width: 1.5 }));
}

export function createTileTools(): ViewportTool[] {
  let stroke: Stroke | null = null;
  let hover: { map: MapRef; cell: Cell } | null = null;
  let drag: { map: MapRef; from: Cell; to: Cell; outline: boolean } | null =
    null;
  let anchor: Cell | null = null;

  const begin = (
    ctx: ViewportContext,
    e: PointerInfo,
    erase: boolean,
  ): boolean => {
    if (e.button !== 0) return false;
    const map = activeMap(ctx.session, ctx.scene.matrices);
    if (!map) return false;
    const cell = cellOf(ctx, map, e);
    if (!cell) return false;
    const brush = tileBrush.get();
    if (!erase && e.alt && inside(map, cell[0], cell[1])) {
      const t = ctx.session.world.entities.find((x) => x.id === map.entity)
        ?.components.tilemap;
      tileBrush.set({
        tile: tileAt(
          { width: map.width, height: map.height, cells: t?.cells as number[] },
          cell[0],
          cell[1],
        ),
      });
      return true;
    }
    const atlas = atlasOf(ctx.session.catalog, map.tileset);
    const tx = ctx.session.begin(erase ? "Erase tiles" : "Paint tiles");
    stroke = {
      map,
      atlas,
      tx,
      last: cell,
      tile: erase ? 0 : brush.tile,
      erase,
    };
    const from = e.shift && anchor ? anchor : cell;
    const cells = lineCells(from, cell).flatMap((c) =>
      footprint(c, brush.size)
    );
    edit(
      tx,
      "Paint",
      map.entity,
      atlas,
      (g, a) => paint(g, cells, stroke!.tile, a, brush.auto),
    );
    anchor = cell;
    ctx.redraw();
    return true;
  };

  const move = (ctx: ViewportContext, e: PointerInfo, dragging: boolean) => {
    const map = activeMap(ctx.session, ctx.scene.matrices);
    if (!map) return;
    const cell = cellOf(ctx, map, e);
    if (!cell) return;
    hover = { map, cell };
    if (
      dragging && stroke &&
      (cell[0] !== stroke.last[0] || cell[1] !== stroke.last[1])
    ) {
      const brush = tileBrush.get();
      const cells = lineCells(stroke.last, cell).flatMap((c) =>
        footprint(c, brush.size)
      );
      const s = stroke;
      edit(
        s.tx,
        "Paint",
        s.map.entity,
        s.atlas,
        (g, a) => paint(g, cells, s.tile, a, brush.auto),
      );
      stroke.last = cell;
      anchor = cell;
    }
    if (dragging && drag) {
      drag.to = cell;
      drag.outline = e.shift;
    }
    ctx.redraw();
  };

  const finish = (ctx: ViewportContext) => {
    stroke?.tx.commit();
    stroke = null;
    ctx.redraw();
  };

  const brushOverlay = (ctx: ViewportContext, color: Line["color"]): Line[] => {
    const map = activeMap(ctx.session, ctx.scene.matrices);
    if (!map) return [];
    const lines = mapBounds(map, RED);
    if (hover && hover.map.entity === map.entity) {
      lines.push(
        ...cellOutline(map, footprint(hover.cell, tileBrush.get().size), color),
      );
    }
    return lines;
  };

  const paintTool: ViewportTool = {
    id: "tile-paint",
    label: "Paint tiles",
    icon: "wand",
    shortcut: "B",
    cursor: "crosshair",
    noGizmo: true,
    pointerDown: (ctx, e) => begin(ctx, e, false),
    pointerMove: move,
    pointerUp: finish,
    overlay: (ctx) => brushOverlay(ctx, YELLOW),
  };
  const eraseTool: ViewportTool = {
    id: "tile-erase",
    label: "Erase tiles",
    icon: "trash",
    shortcut: "E",
    cursor: "crosshair",
    noGizmo: true,
    pointerDown: (ctx, e) => begin(ctx, e, true),
    pointerMove: move,
    pointerUp: finish,
    overlay: (ctx) => brushOverlay(ctx, RED),
  };
  const rectTool: ViewportTool = {
    id: "tile-rect",
    label: "Rectangle",
    icon: "box",
    shortcut: "R",
    cursor: "crosshair",
    noGizmo: true,
    pointerDown(ctx, e) {
      if (e.button !== 0) return false;
      const map = activeMap(ctx.session, ctx.scene.matrices);
      const cell = map && cellOf(ctx, map, e);
      if (!map || !cell) return false;
      drag = { map, from: cell, to: cell, outline: e.shift };
      return true;
    },
    pointerMove: move,
    pointerUp(ctx) {
      const d = drag;
      drag = null;
      if (!d) return;
      const brush = tileBrush.get();
      const atlas = atlasOf(ctx.session.catalog, d.map.tileset);
      const cells = rectCells(d.from, d.to, !d.outline);
      edit(
        ctx.session,
        "Rectangle of tiles",
        d.map.entity,
        atlas,
        (g, a) => paint(g, cells, brush.tile, a, brush.auto),
      );
      ctx.redraw();
    },
    keyDown(ctx, e) {
      if (e.key === "Escape" && drag) {
        drag = null;
        ctx.redraw();
        return true;
      }
    },
    overlay(ctx) {
      const map = activeMap(ctx.session, ctx.scene.matrices);
      if (!map) return [];
      const lines = mapBounds(map, RED);
      if (drag) {
        lines.push(
          ...cellOutline(
            map,
            rectCells(drag.from, drag.to, !drag.outline),
            CYAN,
          ),
        );
      } else if (hover) lines.push(...cellOutline(map, [hover.cell], YELLOW));
      return lines;
    },
  };
  const fillTool: ViewportTool = {
    id: "tile-fill",
    label: "Fill",
    icon: "layers",
    shortcut: "G",
    cursor: "crosshair",
    noGizmo: true,
    pointerDown(ctx, e) {
      if (e.button !== 0) return false;
      const map = activeMap(ctx.session, ctx.scene.matrices);
      const cell = map && cellOf(ctx, map, e);
      if (!map || !cell) return false;
      const brush = tileBrush.get();
      const atlas = atlasOf(ctx.session.catalog, map.tileset);
      edit(
        ctx.session,
        "Fill tiles",
        map.entity,
        atlas,
        (g, a) => paint(g, fillCells(g, cell), brush.tile, a, brush.auto),
      );
      ctx.redraw();
      return true;
    },
    pointerMove(ctx, e) {
      const map = activeMap(ctx.session, ctx.scene.matrices);
      const cell = map && cellOf(ctx, map, e);
      if (map && cell) hover = { map, cell };
      ctx.redraw();
    },
    overlay: (ctx) => brushOverlay(ctx, YELLOW),
  };
  const pickTool: ViewportTool = {
    id: "tile-pick",
    label: "Pick tile",
    icon: "crosshair",
    shortcut: "I",
    cursor: "copy",
    noGizmo: true,
    pointerDown(ctx, e) {
      if (e.button !== 0) return false;
      const map = activeMap(ctx.session, ctx.scene.matrices);
      const cell = map && cellOf(ctx, map, e);
      if (!map || !cell || !inside(map, cell[0], cell[1])) return false;
      const t = ctx.session.world.entities.find((x) => x.id === map.entity)
        ?.components.tilemap;
      tileBrush.set({
        tile: tileAt(
          { width: map.width, height: map.height, cells: t?.cells as number[] },
          cell[0],
          cell[1],
        ),
      });
      return true;
    },
    pointerMove(ctx, e) {
      const map = activeMap(ctx.session, ctx.scene.matrices);
      const cell = map && cellOf(ctx, map, e);
      if (map && cell) hover = { map, cell };
      ctx.redraw();
    },
    overlay: (ctx) => brushOverlay(ctx, CYAN),
  };
  return [paintTool, eraseTool, rectTool, fillTool, pickTool];
}

/** Lines for the texel grid of a 2D view, shown once texels are large enough
 * on screen to be worth drawing (tile-sized cells come from the viewport
 * grid). */
export function pixelGridLines(
  ctx: ViewportContext,
  options: { pixelsPerUnit?: number; minPixels?: number } = {},
): Line[] {
  const ppu = options.pixelsPerUnit ?? 16;
  if (!ctx.camera.orthographic) return [];
  if (1 / ppu / ctx.pixel() < (options.minPixels ?? 7)) return [];
  const a = ctx.planePoint(0, ctx.height), b = ctx.planePoint(ctx.width, 0);
  if (!a || !b) return [];
  const x0 = Math.floor(a[0] * ppu), x1 = Math.ceil(b[0] * ppu);
  const y0 = Math.floor(a[1] * ppu), y1 = Math.ceil(b[1] * ppu);
  const color: Line["color"] = [1, 1, 1, 0.1];
  const lines: Line[] = [];
  for (let i = x0; i <= x1; i++) {
    if (i % ppu === 0) continue;
    lines.push({
      from: [i / ppu, y0 / ppu, 0.01],
      to: [i / ppu, y1 / ppu, 0.01],
      color,
    });
  }
  for (let j = y0; j <= y1; j++) {
    if (j % ppu === 0) continue;
    lines.push({
      from: [x0 / ppu, j / ppu, 0.01],
      to: [x1 / ppu, j / ppu, 0.01],
      color,
    });
  }
  return lines;
}
