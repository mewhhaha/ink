# @ink/brushes

Building blocks for editors of convex-brush levels (Quake-style solids: the
intersection of half-spaces `n · p <= d`). Nothing here knows about a particular
editor or game: tools, panels and pure helpers that any brush-based editor can
compose.

A **brush entity** is an entity with `transform` + `brush` (the standard
components). New brushes have identity rotation and scale, `position` at the
centre of the solid and planes in local space. Resizing, clipping and vertex
editing support rotated, scaled and nested brushes. Edits keep the entity's
pivot and transform, so its children stay in place; collapsed transforms cannot
be edited.

```tsx
import {
  BrushHint,
  BrushToolbar,
  createBrushTools,
  FaceInspector,
  faceSelection,
  TextureBrowser,
} from "@ink/brushes";

const tools = createBrushTools(); // or the shared `brushTools`

<InkApp project="examples/trenchbroom" tools={tools}>
  <TopBar>
    <BrushToolbar tools={tools} />
    <BrushHint />
  </TopBar>
  <Workspace>
    <Viewport id="top" view="top" tools={tools} selectedFaces={faceSelection} />
    <Panel title="Face">
      <FaceInspector />
    </Panel>
    <Panel title="Textures">
      <TextureBrowser />
    </Panel>
  </Workspace>
</InkApp>;
```

Pass the tools to **both** `<InkApp tools>` (hotkeys and the command palette)
and every `<Viewport tools>` that should use them, and
`selectedFaces={faceSelection}` to each view that should highlight the selected
faces.

## Tools (`createBrushTools(options?)`)

Shortcuts avoid the built-in `Q W E R G C F [ ] Delete Ctrl-*`.

| Tool id        | Key | Where  | What                                                                                                                                                                                                                  |
| -------------- | --- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `block`        | B   | 2D, 3D | Drag a rectangle on the grid to create a box brush. The third dimension is the extent of the last brush drawn (`brushDefaults.extent`); in the 3D view the box stands on the ground or the surface under the pointer. |
| `brush-edit`   | V   | 2D     | Drag the eight handles of the selected brush to resize it, drag inside any entity to move it (snapped to the grid, Ctrl inverts snapping). Click selects. In 3D it selects like the default tools.                    |
| `clip`         | X   | 2D, 3D | Click two points in 2D or three surface points in 3D. Tab cycles keep front / back / both, Enter applies, Escape cancels. Green/red outlines preview the result.                                                      |
| `brush-face`   | T   | 3D     | Click faces to select them, Shift toggles, Ctrl takes the whole brush. Stored in `faceSelection`.                                                                                                                     |
| `brush-vertex` | J   | 2D, 3D | Drag a vertex square or edge midpoint; Shift adds handles. The resulting solid is the convex hull of the moved vertices.                                                                                              |

The Select tool (Q) also supports marquee selection: drag right for containment
or left for crossing. Shift adds and Ctrl toggles. Resize handles show the
direction of the drag in the cursor.

Every drag is a session transaction (`session.begin` -> `update` -> `commit`):
one undo step, and edits are live while the game is playing.

`createBrushTools({ name, components, defaults })`: `name` is the entity name of
new brushes, `components` extra components for them (`{ solid: {} }`),
`defaults` a replacement for `brushDefaults`.

## State

- `faceSelection` — `{ get, set, add, toggle, clear, subscribe }` over
  `{ entity, face }[]`; `useFaceSelection()` in React. Matches the
  `selectedFaces` prop of `<Viewport>` and the renderer's
  `Overlays.selectedFaces`.
- `brushDefaults` — a `Store` with the texture path for new brushes and the
  remembered extent per axis; `useBrushDefaults()`.
- `clipState` — keep mode and number of points of the clip tool.

## Panels

- `<BrushToolbar tools?>` — the tools as toolbar buttons.
- `<BrushHint />` — one-line instructions for the active tool.
- `<FaceInspector />` — texture, colour, offset, scale and rotation of the
  selected faces (edited on all of them at once), with Fit, Align, Reset,
  rotate, flip and "copy to brush" buttons.
- `<TextureBrowser />` — catalog textures. Click applies to the selected faces,
  or to every face of the selected brushes; with nothing selected (or Shift) it
  sets the texture of new brushes.

## Helpers (pure, see `edit.ts`)

`newBrushComponents(min, max, { texture, color, extra })` returns scene-style
components for `session.createEntity`. Also `dragBox`, `boxEdges`, `resizeBrush`
(stretches world-space bounds without moving the pivot), `clipPlaneThrough`,
`clipBrushEntity`, `brushVertices`, `moveBrushVertices`, `fitFace`, `alignFace`,
`surfaceOf` / `withSurface`, `brushWorldBounds`. `BrushEntityData.matrix` is the
complete local-to-world transform, including parents.

## In the game

Games collide with brushes through `ink/collide` (`slide`, `ray_brush`,
`planes_at`); see `examples/trenchbroom/game/main.blot`.
