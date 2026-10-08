/**
 * @ink/brushes: building blocks for editors of convex-brush levels.
 *
 *   const tools = createBrushTools();
 *   <InkApp tools={tools}>
 *     <TopBar><BrushToolbar tools={tools} /></TopBar>
 *     ...
 *     <Viewport id="main" tools={tools} selectedFaces={faceSelection} />
 *     <Panel title="Face"><FaceInspector /></Panel>
 *     <Panel title="Textures"><TextureBrowser /></Panel>
 *   </InkApp>
 *
 * A brush entity has `transform` + `brush`; new brushes are axis-aligned boxes
 * with identity rotation and scale, the position at the centre and the planes
 * in local space. Games collide with them through `ink/collide`.
 */
export {
  alignFace,
  type Axis,
  boxEdges,
  type BrushEntityData,
  brushWorldBounds,
  clipBrushEntity,
  type ClipKeep,
  clipKeepOrder,
  clipPlaneThrough,
  type ClipResult,
  dragBox,
  type EdgeMove,
  fitFace,
  isTranslationOnly,
  localBounds,
  moveBrush,
  newBrushComponents,
  type NewBrushOptions,
  nextClipKeep,
  normalizeBox,
  rebaseBrush,
  resizeBrush,
  type Surface,
  surfaceOf,
  withSurface,
} from "./edit.ts";
export {
  type BrushDefaults,
  brushDefaults,
  type ClipState,
  clipState,
  type FaceRef,
  faceSelection,
  useBrushDefaults,
  useFaceSelection,
} from "./state.ts";
export {
  brushDataOf,
  type BrushToolOptions,
  brushTools,
  createBrushTools,
  orthoOf,
} from "./tools.ts";
export {
  BrushHint,
  BrushToolbar,
  FaceInspector,
  TextureBrowser,
} from "./panels.tsx";
