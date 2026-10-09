/**
 * @ink/tiles: building blocks for editors of tile maps.
 *
 *   const tools = createTileTools();
 *   <InkApp tools={tools}>
 *     <TopBar><TileToolbar tools={tools} /></TopBar>
 *     <Viewport id="level" view="front" tools={tools} overlay={tileOverlay} />
 *     <Panel title="Tiles"><TilePalette /></Panel>
 *     <Panel title="Layers"><TileLayers /></Panel>
 *   </InkApp>
 *
 * A tile map is a standard `tilemap` component whose `cells` hold atlas frame
 * ids; paint tools edit it through the session, so every stroke is undoable
 * and works while the game runs. Games read the same cells through `ink/tiles`.
 */
export {
  autotileRule,
  type Cell,
  cellAtPoint,
  conformCells,
  fillCells,
  inside,
  lineCells,
  paint,
  rectCells,
  resizeCells,
  retile,
  stamp,
  tileAt,
  type TileGrid,
} from "./edit.ts";
export {
  chooseLayer,
  type TileBrush,
  tileBrush,
  useTileBrush,
} from "./state.ts";
export {
  activeMap,
  atlasOf,
  createTileTools,
  mapBounds,
  type MapRef,
  pixelGridLines,
} from "./tools.ts";
export { TileHint, TileLayers, TilePalette, TileToolbar } from "./panels.tsx";
