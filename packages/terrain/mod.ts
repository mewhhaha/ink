/**
 * @ink/terrain: building blocks for editors of heightfield terrain and
 * instance layers.
 *
 *   const tools = createTerrainTools();
 *   <InkApp tools={tools} commands={terrainCommands}>
 *     <TopBar><TerrainToolbar tools={tools} /></TopBar>
 *     <Viewport id="main" tools={tools} />
 *     <Panel title="Terrain"><TerrainBrushPanel /></Panel>
 *     <Panel title="New"><NewTerrainForm /><NewScatterForm /></Panel>
 *   </InkApp>
 *
 * The heights, splat weights and placements live in `*.terrain` and
 * `*.scatter` assets that the renderer streams (`renderer.assets.terrain`,
 * `.scatter`). The tools edit that data directly while the pointer drags and
 * record one session edit when it ends, so a stroke is a single undo step;
 * `<TerrainSync>` (mounted by `<TerrainToolbar>`) moves the data along with
 * undo, redo and the timeline, and saves it to disk through the dev server.
 * See the README.
 */
export {
  type Dab,
  DabPath,
  dabSpacing,
  type Falloff,
  type FalloffShape,
  falloffShapes,
  falloffWeight,
  flatten,
  type FlattenTarget,
  type Footprint,
  footprint,
  type Ground,
  type NoiseBrush,
  noiseRelief,
  paintLayer,
  raise,
  smooth,
} from "./sculpt.ts";
export {
  raycastTerrain,
  raycastTerrains,
  type TerrainHit,
  type TerrainSurface,
} from "./raycast.ts";
export { STROKE_TILE, StrokeRecorder } from "./stroke.ts";
export {
  MAX_CANDIDATES,
  planAdd,
  planErase,
  type ScatterBrush,
  scatterCandidates,
} from "./scatter_brush.ts";
export { ScatterStroke } from "./scatter_stroke.ts";
export {
  type AssetSink,
  type SaverOptions,
  ScatterSaver,
  type Segment,
  TerrainSaver,
  terrainSegments,
} from "./save.ts";
export {
  gridCells,
  type GridState,
  gridState,
  paramsOf,
  updateGrid,
} from "./grid.ts";
export { commitScatter, commitTerrain, rebuildCollisionGrids } from "./edit.ts";
export { type AssetRef, type WorldRefs, worldRefs } from "./world.ts";
export {
  type SyncAssets,
  type SyncSession,
  WorldSync,
  type WorldSyncOptions,
} from "./sync.ts";
export { TerrainSync, useTerrainSync } from "./sync.tsx";
export {
  clampBrush,
  defaultBrush,
  heightPerDab,
  scaleRadius,
  type TerrainBrush,
  terrainBrush,
  type TerrainTargets,
  terrainTargets,
  useTerrainBrush,
} from "./state.ts";
export {
  hitTerrain,
  pickTerrain,
  readyTerrains,
  type ScatterTarget,
  scatterTarget,
  type TerrainTarget,
} from "./targets.ts";
export { createTerrainTools, type SculptKind, terrainHint } from "./tools.ts";
export {
  assetSlug,
  createScatter,
  createTerrain,
  layerNames,
  layerPalette,
  type NewTerrain,
  newTerrainPlan,
  waitForAsset,
} from "./create.ts";
export { terrainCommands } from "./commands.ts";
export {
  NewScatterForm,
  NewTerrainForm,
  TerrainBrushPanel,
  TerrainHint,
  TerrainToolbar,
} from "./panels.tsx";
