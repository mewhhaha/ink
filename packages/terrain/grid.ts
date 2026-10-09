/**
 * The collision grid a `terrain` component carries for game code
 * (`ink/terrain`): `(collision_cells + 1)^2` heights in metres, `height_scale`
 * applied, sampled evenly from the heightmap. The tools update the part of
 * it a stroke changes; this module also detects and rebuilds a grid that is
 * missing or out of step (a scene written by a script, or a changed
 * `height_scale`).
 */
import {
  collisionGrid,
  collisionRect,
  type Heightfield,
  type TerrainParams,
  type TerrainRect,
} from "@ink/geometry";

type Component = Record<string, unknown>;

const num = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** Parameters of the height function in a `terrain` component. */
export function paramsOf(t: Component): TerrainParams {
  return {
    size: Math.max(1, num(t.size, 2048)),
    heightScale: num(t.height_scale, 1),
    detail: {
      seed: num(t.detail_seed, 1),
      amplitude: num(t.detail_amplitude, 0.35),
      wavelength: num(t.detail_wavelength, 6),
      octaves: num(t.detail_octaves, 3),
    },
  };
}

/** Cells per side of the component's collision grid. */
export const gridCells = (t: Component) =>
  Math.min(256, Math.max(8, Math.round(num(t.collision_cells, 128))));

export type GridState = "ok" | "missing" | "stale";

/** Whether the grid matches the field: `missing` when it has the wrong
 * length (empty, or `collision_cells` changed), `stale` when the heights
 * differ from the heightmap's. */
export function gridState(t: Component, field: Heightfield): GridState {
  const cells = gridCells(t);
  const grid = t.grid;
  if (!Array.isArray(grid) || grid.length !== (cells + 1) ** 2) {
    return "missing";
  }
  const expected = collisionGrid(field, paramsOf(t), cells);
  for (let i = 0; i < expected.length; i++) {
    if (Math.abs(expected[i] - (grid[i] as number)) > 1e-3) return "stale";
  }
  return "ok";
}

/** Rewrite `t.grid` for a change to the field: the cells `area` touches, or
 * everything when the grid does not fit or `area` is omitted. */
export function updateGrid(
  t: Component,
  field: Heightfield,
  area?: TerrainRect | null,
): void {
  const cells = gridCells(t);
  const params = paramsOf(t);
  const grid = t.grid;
  if (
    area && Array.isArray(grid) && grid.length === (cells + 1) ** 2
  ) {
    const next = Float32Array.from(grid as number[]);
    collisionGrid(
      field,
      params,
      cells,
      collisionRect(area, field.cells, cells),
      next,
    );
    t.grid = Array.from(next);
  } else {
    t.grid = Array.from(collisionGrid(field, params, cells));
  }
}
