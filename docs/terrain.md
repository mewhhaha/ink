# Large worlds: terrain, scatter and streaming

Hill 10 adds ground and instances at the scale of kilometres: a heightfield
terrain with noise detail and painted layers, scatter layers that draw tens of
thousands of instances of one mesh without making them entities, culling on the
GPU, and streaming of everything that does not fit in memory at once. The gate
is `examples/terrain`: 2 km x 2 km (4.2 km²) with more than 100,000 instances,
edited and played in the browser.

## Components and assets

`standard.componentsWorld` holds two components (spread it into a schema, or
pick `standard.terrain` / `standard.scatter`):

- **`terrain`**: `heightmap` (a `*.terrain` asset), `size` (metres, the terrain
  is a square centred on the entity; rotation and scale are ignored),
  `height_scale`, up to eight `layers` (albedo, normal with the blend height in
  alpha, ORM, tiling in metres, tint), `blend_height`, procedural `detail_*`
  (amplitude, wavelength, octaves, seed), `lod_distance`, `collision_cells` and
  a hidden `grid`/`revision`.
- **`scatter`**: `shape` (a mesh), `placements` (a `*.scatter` asset), material
  parameters, `follow_terrain` (y becomes an offset above the first terrain),
  `align_to_ground`, `max_distance`, `lod_bias`, `cast_shadows`, `alpha_cutout`.

The big data lives in assets, not in the world packet:

| File        | Contents                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `*.terrain` | header, a decimated overview, `(cells+1)²` f32 heights, `splatCells²` RGBA8 weights per plane (4 layers each); `packages/geometry/terrain.ts` |
| `*.scatter` | header and `[x, y, z, yaw, scale, tint]` f32 records sorted by 128 m chunk; `packages/geometry/scatter.ts`                                    |

A 2048-cell terrain with four layers is 21 MB; 100,000 placements are 2.4 MB.
Both files carry a `revision`. The component's `revision` ties the scene to the
file: a stroke bumps both, scene undo/redo/rewind changes the component's
revision and `TerrainResource.seek` / `ScatterResource.seek` move the data to
match (history is kept for the session, as strokes' before/after patches).

## Ground height everywhere: one function

```
height(x, z) = bilinear(field)(x, z) * height_scale + amplitude * fbm2(seed, octaves, (x, z) / wavelength)
```

The noise is `ink/noise`'s `perlin3`/`fbm2`, word for word: a TypeScript port in
`packages/geometry/terrain.ts` (`terrainHeightAt`) and a WGSL port in the
terrain shader give the same ground as Blot. The renderer fades octaves finer
than four grid spacings so coarse patches do not shimmer; the CPU and Blot
evaluate every octave.

## Rendering

`packages/render/terrain_gpu.ts`, `terrain_pipelines.ts`, `shaders/terrain.ts`.

- **Patches.** A CPU quadtree (`TerrainGpu.select`, a few hundred nodes per
  view) refines by distance to the camera: a patch of level L stays whole while
  it is farther than `lod_distance / 32` times its size. Every patch is the same
  32 x 32 quad grid, instanced; the vertex shader reads heights with
  `textureLoad` (vertex texture fetch) and morphs vertices to the next coarser
  grid over the last 30 % of the patch's range (CDLOD), so neighbouring levels
  meet without cracks (checked by `terrain levels meet without cracks`: a
  magenta clear colour shows nowhere inside the terrain). Culling uses a min/max
  tree of the heights (`TerrainResource.boundsOf`), updated only for the leaves
  an edit touches.
- **Textures.** Heights are one `r32float` level; slopes are `rg16float` with a
  full mip chain (distant ground is prefiltered); splat weights are an `rgba8`
  array with mips; layer textures are copied (with mips) into 1024² arrays.
  Normals come from the slope texture, with the procedural detail's slope added
  per vertex; layers blend with height-based blending and shade through the same
  `shadeSurface` as meshes, so cascaded shadows, clustered lights, AO, fog,
  reflections and TAA velocity all apply.
- **Passes.** Lit, sun shadow cascades (own patch lists per cascade), AO
  prepass, reflection prepass, motion vectors and picking draw the terrain;
  picking returns the entity and the exact point. Spot/point shadows and
  lightmap bakes ignore terrain.
- **Edits** upload only the touched rectangle (heights, slopes and splat with
  their mips are recomputed for that rectangle on the CPU and written with
  `writeTexture`), immediately.

## Scatter

`scatter_gpu.ts`, `shaders/scatter.ts`, `world.ts`.

Placements are bucketed in 128 m chunks (`ChunkIndex`) on the CPU. A layer keeps
on the GPU the chunks within `max_distance` of the camera (with hysteresis), up
to 400,000 placements, so far chunks stream in and out as the camera moves. One
compute dispatch per layer and frame has a thread per resident placement:

1. place it (yaw, scale, y from the terrain's height texture and detail noise,
   optional tilt to the ground normal);
2. test its bounding sphere against the camera frustum, up to four sun cascades
   (the near plane is skipped for cascades), `max_distance`, and last frame's
   **hierarchical depth pyramid** (the farthest depth of every 2 x 2 pixels and
   samples, reprojected with the previous camera);
3. choose the mesh level from its projected error (hill 13's `INK_mesh_lods`,
   1.5 px) and append a complete 224-byte `Instance` record to that list's and
   level's range.

Every pass then draws each list's levels with `drawIndexedIndirect` over a bind
group that exposes the range as the instance buffer, so the existing mesh
shaders (lit, shadow, AO, SSR, motion, pick) work unchanged. Overlays
`culling: "none" | "frustum" | "occlusion"` selects the tests.

Limits: 8192 instances per level for the camera, 4096 per level and cascade;
more are dropped, nearest-thread-first-served (`view.scatterCounts()` reads the
counts back). Occlusion uses the previous frame's depth, so something revealed
by a moving occluder appears a frame late; it is off for orthographic views and
after resizes and camera cuts. Instances do not cast spot/point shadows, and
only the first sun's cascades cull scatter. There are no impostors: far trees
use the importer's coarsest level and the layer's distance limit.

## Streaming and budgets

- **Terrain**: the file streams (`response.body`): the overview is shown first
  (bilinearly upsampled); once complete, 256 x 256 tiles are uploaded nearest
  the camera first, three per frame. Captures (`still`) upload everything.
- **Scatter**: chunk residency as above.
- **Meshes and textures**: `Assets.memoryBudget` (default 1 GiB, estimated)
  makes `endFrame` release the least recently used reloadable meshes and
  textures idle for at least 30 frames; they stream back in when drawn again.

## Game code

`ink/terrain` (see `docs/blot.md`) reads the coarse `grid` the terrain component
carries: `terrain.height`, `normal`, `slope`, `stand`/`stick` for characters.
The grid is `(collision_cells + 1)²` heights (at most 257²), kept in step with
the heightmap by the terrain tools in the same undoable edit, so rewind and
hand-offs reproduce it. The procedural detail is evaluated exactly, so only the
painted heightmap is sampled coarsely.

## Editing

`@ink/terrain` (`packages/terrain`, README there) is a tool package like
`@ink/brushes`: raise, lower, smooth, flatten, noise, paint (splat layers) and
scatter tools with radius, strength, falloff and spacing, a CPU raycast against
the heightfield (a walk over the min/max tree, then bisection), panels, and
`<TerrainSync>`. A drag edits the shared data directly, so the renderer shows it
at once (only the touched rectangle is uploaded); when it ends one
`session.edit` records the new `revision` and refreshes the collision `grid`
cells the stroke touched, so a drag is one undo step. `TerrainSaver` writes the
changed byte ranges back with `PATCH /__ink/assets-write/<path>` (the watcher
does not echo those writes back as reloads). A dab on a 2049² field with a 64 m
radius costs 0.1 to 0.5 ms (noise, 15 ms: three octaves of Perlin per sample).
Strokes made in a session can be undone and redone; a file edited elsewhere
reloads and carries no history.

## The gate

`examples/terrain` (`deno task gen:terrain` writes its big assets): 2049² height
samples at 1 m (4.2 km²), four splat layers, 100,000 scatter placements (14,000
pines, 8,000 oaks, 24,000 rocks, 54,000 grass tufts), a walker that stands on
the ground through `ink/terrain`, and the terrain tools in the editor.

- `deno task test:terrain` runs `scripts/terrain-smoke.ts` (the renderer's
  checks, `packages/render/terrain_checks.ts`, in Chromium) and
  `scripts/terrain-gate.ts`, which flies the camera, plays, and drags real raise
  and paint strokes with the mouse, then undoes them and compares the data. Pass
  `--hardware [--headed]` to either script for a real GPU; pictures land in
  `tmp/terrain-*.png`.
- `deno test -A packages/render/terrain_test.ts` runs the same checks on Deno's
  WebGPU.
