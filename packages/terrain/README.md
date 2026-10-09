# @ink/terrain

Editing tools for heightfield terrain and instance layers: the brushes, their
undo, saving to disk and the panels. Core packages know nothing of it; an editor
for a game with large worlds composes it (`examples/terrain`).

```tsx
const tools = createTerrainTools();

<InkApp project="examples/terrain" tools={tools} commands={terrainCommands}>
  <TopBar>
    <TerrainToolbar tools={tools} />
    <TerrainHint />
  </TopBar>
  <Viewport id="main" tools={tools} />
  <Panel title="Terrain">
    <TerrainBrushPanel />
    <NewTerrainForm />
    <NewScatterForm />
  </Panel>
</InkApp>;
```

`<TerrainToolbar>` also mounts `<TerrainSync>` (see below); mount that yourself
if you lay the toolbar out differently.

## Tools

| Tool    | Key | What it does                                                                         |
| ------- | --- | ------------------------------------------------------------------------------------ |
| raise   | 1   | builds ground up; Ctrl lowers, Shift smooths                                         |
| lower   | 2   | digs; Ctrl raises, Shift smooths                                                     |
| smooth  | 3   | relaxes the ground toward its local average                                          |
| flatten | 4   | levels to where the stroke began or a fixed height; Ctrl+click samples the height    |
| noise   | 5   | adds relief from `terrainNoise` (the noise the renderer and Blot use); Ctrl digs     |
| paint   | 6   | paints a splat layer (the others give way, weights keep summing to 255); Ctrl erases |
| scatter | 7   | places instances of the selected scatter layer on the ground; Ctrl erases            |

`[` and `]` resize the brush (with Shift, change its strength); Esc cancels a
stroke; holding still keeps building up (airbrush). Brush settings: radius,
strength, falloff curve and hardness, dab spacing as a fraction of the radius.
Dabs are placed along the drag at that spacing (`DabPath`), so a stroke does not
depend on how often the pointer reports.

## Which terrain

Sculpt and paint tools edit the **selected terrain entity**; with none selected,
the terrain under the pointer. The panel can pin one (`terrainTargets`). The
scatter tool edits the selected scatter entity, the pinned one, or else the
first in the scene, and places instances on the **first terrain** (the ground
the renderer puts `follow_terrain` instances on); `y` is then the lift above it.
The ground under the pointer is found on the CPU by `raycastTerrain`: a walk
over the terrain's min/max tree, then bisection. It includes the procedural
detail.

## Strokes, undo and saving

The data (`renderer.assets.terrain(path)`, `.scatter(path)`) changes while the
pointer drags, so the renderer shows it at once. When the drag ends, one
`session.edit` records the data's new `revision` in the entity's component (and
for a terrain refreshes the collision `grid` for the cells the stroke touched).
So one drag is one undo step, works in play mode like any edit and is carried by
the timeline and hand-offs.

- `StrokeRecorder` saves each 64-sample tile the first time a dab is about to
  change it and, at the end, commits every changed tile to the resource's
  history (`TerrainResource.commit`). A drag across a kilometre costs only the
  tiles it touched, not the whole field.
- `WorldSync` (`<TerrainSync>`, `useTerrainSync()`) watches the session. When
  the scene's revision differs from the data's, because of undo, redo, rewinding
  or loading a scene, it calls `resource.seek(revision)`. A revision the data
  has no history for (a scene saved by another session) is left alone.
- Edits are saved at once, not with the scene: `TerrainSaver` sends the changed
  height rows, splat texels, overview samples and the revision as byte ranges of
  one `PATCH /__ink/assets-write/<path>`, a moment after the last change;
  `ScatterSaver` replaces the (small) `.scatter` file. The dev server does not
  echo its own writes back as an asset reload; a script rewriting the file still
  reloads it.
- A scene whose `grid` is empty or the wrong length (written by a script) is
  reported in the panel and rebuilt by the **Rebuild collision grid** button or
  the `terrain-rebuild-grid` command. Nothing rebuilds it behind your back.

New terrain: `NewTerrainForm` writes a flat `.terrain` file through the dev
server (`createAsset` + `patchAsset`) and adds an entity; `NewScatterForm` does
the same for an empty `.scatter`.

## Scatter brush

Candidates come from a jittered grid hashed from the seed and the cell, not a
random stream: the same place always offers the same instance, repeating a dab
adds nothing, and density does not depend on pointer speed. Density is per 100
m^2, `minSpacing` rejects neighbours, yaw is random, scale and tint are drawn
from ranges, `maxSlope` skips steep ground.

## Cost of a dab

`deno task bench:terrain` (2049x2049 field, radius 64 m, so 129x129 samples per
dab): raise 0.09 ms, smooth 0.34 ms, flatten 0.2 ms, paint 0.12 ms, noise about
15 ms (three octaves of Perlin per sample). Every operation reads and writes
only the dab's rectangle.
