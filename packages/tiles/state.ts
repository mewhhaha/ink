/** Editing state of the tile tools: presentation, never game state. */
import { Store, useStore } from "@ink/react";

export interface TileBrush {
  /** The tile id (atlas frame id) the tools paint; 0 paints empty tiles. */
  tile: number;
  /** The entity id of the tile map layer being edited; 0 picks the selected
   * map, or else the first one. */
  layer: number;
  /** Re-pick variants of auto-tiling groups as tiles are painted or erased. */
  auto: boolean;
  /** Stamp size in cells for paint and erase (a square). */
  size: number;
}

export const tileBrush: Store<TileBrush> = new Store<TileBrush>({
  tile: 0,
  layer: 0,
  auto: true,
  size: 1,
});

export function useTileBrush(): TileBrush {
  return useStore(tileBrush, (s) => s);
}

/** What a tool is previewing, for the toolbar hint. */
export const tileHover: Store<
  { cell: [number, number] | null; layer: number }
> = new Store<{ cell: [number, number] | null; layer: number }>({
  cell: null,
  layer: 0,
});

/** The layer the tools edit: the chosen one, else the selected map, else the
 * base layer (layer 0), else the first map in the world. */
export function chooseLayer<
  E extends { id: number; components: Record<string, Record<string, unknown>> },
>(
  entities: readonly E[],
  selection: readonly number[],
  layer: number,
): E | undefined {
  const maps = entities.filter((e) => e.components.tilemap);
  return maps.find((e) => e.id === layer) ??
    maps.find((e) => selection.includes(e.id)) ??
    maps.find((e) => Number(e.components.tilemap.layer) === 0) ?? maps[0];
}
