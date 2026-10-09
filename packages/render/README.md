# @ink/render

WebGPU renderer for Ink worlds. One `Renderer` per device, any number of
`View`s.

```ts
const renderer = await createRenderer({ assetBase: "/assets/" });
const view = renderer.createView(canvas); // or { width, height } offscreen
view.resize(cssW, cssH, devicePixelRatio);
const scene = extractScene(world, catalog, { hidden });
view.render(scene, camera, {
  grid: { plane: "xz", spacing: 1 },
  selection: [id],
  environment: { exposure: 0.5 }, // per-view override of the scene's
});
const hit = await view.pick(x, y); // CSS px
const png = await view.capture(); // Blob
```

Colours (components, lines, overlays) are sRGB 0..1. Lighting is linear HDR; the
picture is tonemapped in post and the final pass encodes sRGB.

## A frame

```
sun cascades ─┐ systems (prepare, then encode; see Extension points):
spot / point  │ shadow maps are skipped while nothing they depend on changes,
AO prepass +  │ the sun's four cascades, the spot atlas, six cube faces per
GTAO + blur ──┘ point light, normal prepass + GTAO + blur at half resolution
main pass     4x MSAA, rgba16float, scene radiance in linear HDR: sky, meshes
              (wireframe in wireframe mode). Stored tonemap-weighted
              (c / (1 + max(c))) so the hardware resolve weights bright
              samples less and bright edges do not alias; decoded after.
overlay pass  4x MSAA rgba8unorm-srgb, premultiplied: the 2D layer (sprites,
              tile maps, text), then grid, face fills, lines.
              Depth-tested read-only against the scene depth. Skipped when
              there is nothing to draw. Never exposed, tonemapped or bloomed.
post          decode -> [auto exposure] -> [bloom] -> composite
temporal      optional motion vectors + native-resolution history resolve
mask pass     selection / hover mask, depth-tested (only when flagged)
final pass    selection outline, sRGB encode, blue-noise dither
```

Translucent meshes and particles use a separate linear-HDR MSAA layer with
read-only opaque depth. It is composed after unpacking opaque radiance, before
exposure and bloom. This preserves correct blending with the main pass's
compressed HDR representation. The layer and particle buffers are released when
unused.

### Temporal anti-aliasing and render resolution

`view.render(scene, camera, { temporal: true, renderScale: 0.5 })` shades at
half width and height, then reconstructs the full-size canvas. `renderScale`
accepts 0.5..1; it also works without temporal accumulation. The React viewport
and player enable temporal anti-aliasing by default in 3D/game views and expose
persisted image settings. Paused views converge for 16 frames, then stop
drawing.

An eight-phase projection jitter and a velocity pass track the previous camera,
object transforms, skin palettes and morph weights. Each view retains its own
previous pose; game state never stores rendering history. A native-resolution
color/depth pair rejects disocclusions and newly visible geometry, clips stale
color against the current neighbourhood, and reconstructs subpixel samples with
Catmull-Rom filtering. Transparency reduces the history weight to avoid trails.
AO and soft shadows vary their samples; grain accumulates with the shaded image.
Grid, tool lines and selection overlays are composed after accumulation.

History resets after backward ticks, camera cuts, lens changes, resizing, asset
replacement or `resetHistory: true`. Set `RenderScene.tick` when supplying a
scene directly; `extractScene` already does this. Captures rendered with
`still: true` bypass temporal history and remain exactly reproducible. Ordinary
`capture()` reads the last displayed frame. `view.stats` reports internal
dimensions and accumulated frame count; picks and output pixels retain their
usual CSS/canvas coordinates.

`deno task test:temporal` checks moving edges against a supersampled image,
rigid/skeletal/morph motion equivalence, noise reduction, disocclusion, seeks,
resizing and viewport controls in Chromium. It also captures the moving Feel Lab
character at half resolution. Fine detail is softer at 50%; particles and
transparent surfaces use a reactive mask, without their own motion vectors.

### Bounce light and reflections

Set `environment.indirect` above zero to bake diffuse bounce light on static
brush faces. Brushes opt in by default; turn off `brush.bake_lighting` for doors
and other moving solids. Static meshes can contribute occlusion and bounced
radiance with `mesh.bake_lighting`; they do not receive lightmaps. A GPU path
tracer traverses a CPU-built triangle BVH, with shadowed direct lighting and two
diffuse bounces. Texture averages tint bounced light. Each brush face has a 12 ×
12 texel chart with a padded border.

Geometry, lights, materials, loaded assets and probe edits restart the bake.
Interactive frames add two samples until 32 samples have accumulated. The
viewport and player keep drawing while `view.stats.pendingWork` is true;
`lightmapSamples` and `lightmapCharts` report progress. `still: true` finishes
all remaining samples in one submission, in the same deterministic order. The
bake belongs to the view and is released when disabled or disposed; it is not
stored in game state or persisted to disk.

A `reflection_probe` entity captures static geometry into a 32 × 32 cube with
GGX-filtered roughness mips. `size` sets its local box; `blend` fades inside its
edges. Extend the box slightly beyond the surfaces it lights. Reflections use
box projection, blend overlapping probes, and fall back to sky lighting outside
them. Select a probe to see its bounds. GPU array-layer limits bound the number
of probes. Captures use diffuse material colors, average texture colors and a
flat sky color; they do not capture moving geometry or full texture detail.

`environment.reflections` enables screen-space reflections for smooth opaque
surfaces. The pass traces the current view's depth, refines intersections, and
replaces the matching probe/sky contribution. Offscreen and obscured geometry
uses the probe fallback. Rough surfaces fade to probes; transparent objects do
not participate. Temporal anti-aliasing can stabilize the result.

Hammer demonstrates room probes, a polished panel and lamp bounce behind its
pillars. `deno task test:gi` checks incremental lightmaps, edited blockers,
deterministic undo, moving reflections and resource cleanup in Chromium, then
edits Hammer's actual room and records rebake timings and before/after images.

### Transparency and particles

Mesh `alpha_mode` is `opaque`, `mask`, `blend` or `additive`. `alpha_cutoff`
defaults to 0.5; `double_sided` disables back-face culling. Cutouts apply to
color, picking, selection masks, shadows and AO. Blended surfaces do not write
depth or cast opaque shadows. Object centers sort back to front; intersecting
objects should be split into separate meshes when that order is ambiguous.

The standard `emitter` component describes rate, seed, lifetime, velocity,
spread, gravity, spawn radius, birth/death size and color, intensity, optional
texture and soft/spark shape. `additive` enables emitted light. A rate of zero
is burst-only. Continuous particles follow the emitter's transform; a
`particles` event names an emitter, world position, count and seed for a burst.
Keep its emitter entity alive for the effect's duration. Particle positions and
depth sorting run in compute; no particle state enters the world packet.

Pass `{ dt, events: session.presentationEvents }` to `extractScene`; the React
and shipping players already do this. Continuous birth indices and burst ages
derive from the world tick, so pausing, seeking and recreating a view cannot
change them. The timeline retains presentation events independently of audio
dispatch. Handoffs include events still alive before their replay keyframe.

Limits: 64 emitter/burst batches per view (first in extraction order), 2048
particles per batch, ten-second lifetimes. Each batch sorts its particles in
compute; batches interleave with transparent meshes by center depth. Particles
are unlit billboards without collision or opaque shadows. The Godot `particles`
scene and `deno task test:particles` demonstrate fire, smoke, glass and sparks,
and check exact pictures after rewind and handoff replay.

### 2D: sprites, tile maps, text and lights

`standard.components2d` (`sprite`, `tilemap`, `light2d`, `text`) draws on the
entity's XY plane. They are kept out of `standard.components`, so 3D schemas do
not carry them: spread `standard.components2d` or pick the ones a game needs.

```ts
// scene.sprites, tilemaps, texts and lights2d come from extractScene. Pass
// `text` to turn a text component into a string (messages, entity names).
const scene = extractScene(world, catalog, {
  assets: renderer.assets,
  text: (entity, message, a, b) => session.message(message, a, b),
});
```

**Atlases** are `*.atlas.json` files (`@ink/schema`'s `parseAtlas` documents the
format): an image sliced by a grid and/or free rectangles into named frames,
with animations, per-frame tile flags (`solid`, `oneway`, `ladder`, `hazard`),
auto-tile rules and an optional `normals` image with the same layout. Frame ids
are 1-based (grid cells row by row, then the free rectangles); 0 means the whole
image in a sprite and "empty" in a tile map. The asset store loads and parses
atlas files on demand (`assets.atlas(path)`); editing one reloads it live and a
file that does not parse keeps the last good version.

**Where it draws.** The 2D layer is the first thing in the overlay pass. It is
display-referred: not exposed, tonemapped, bloomed or graded, so pixel art keeps
its exact colours (give the scene's `environment` `tonemap: linear` so a sky
background matches). It is depth-tested read-only against the scene, so it mixes
with 3D by position. With temporal anti-aliasing the overlay is composed after
accumulation, and a view with 2D content ignores `renderScale`, so sprites are
never jittered or upscaled (`view.stats.sprites` counts the draws). Everything
is one pass of instanced quads in painter's order: `layer`, then plain items
before `y_sort` sprites, then world order (or lower `y` in front). Sprites
sample level 0 with a nearest filter unless `smooth` is set (`snap` rounds the
origin to the image's pixel grid) and clamp inside their frame, so neighbouring
atlas frames never bleed.

**Tile maps** are one quad per map. A `r16uint` texture holds the tile ids (it
is rewritten only when the cells change) and a small table gives each id's
rectangle, so a 1,024 x 1,024 map is one draw. A map's origin is the bottom left
corner of cell (0, 0); rows run bottom to top.

**Light.** 2D content is unlit until the scene has a `light2d`. Then a surface's
colour is multiplied by the ambient lights plus every lamp, spotlight and sun
(up to 128): `radius` and `falloff` shape the fade, `height` lifts the light
above the plane for normal maps. Surfaces with a normal map (the atlas's
`normals` image: tangent space, +Y up, rotated and flipped with the sprite) are
shaded by the light's direction; without one they are lit evenly. Lights with
`shadows` are blocked by the solid tiles (atlas flag `solid`) of the first
`tilemap` with `occluder` set: a ray marches the tile grid three samples per
cell, up to 120 steps. Solid tiles are lit as walls and only cast onto what is
not solid; sprites cast no shadows; one occluder map per view.

**Text** is a signed distance field. The built-in font is a public 5x7 pixel
font (ASCII 32 to 126; lowercase letters have no descenders), smoothed with two
EPX passes and turned into an atlas on the CPU on first use (about 40 ms), so
text is scalable, outlined, anti-aliased, deterministic and needs no font file.
`size` is a line's height in world units (an eighth of it per font pixel); `\n`
starts a new line; `outline` is the width in font pixels. A game shows
translated text by setting a message and its two numbers; Blot never handles
strings.

**Picking** is CPU-side against the same quads (`view.pick` returns the tile
under the pointer as `cell`); 2D content wins over 3D under the pointer.
`sceneGizmos2d(scene, assets, { selection, hovered })` outlines selected
sprites, maps and text, and draws light positions and reach for editor views.

`deno task test:sprites` (and
`deno test --unstable-webgpu
packages/render/sprites_gpu_test.ts`) checks crisp
texels, atlas frames and flips, layers, tile maps, picking, text, ambient and
normal-mapped light, tile shadows, depth beside 3D, accumulation and render
scale, and atlas and image reload on real pixels.

### Imported models and animation

glTF/GLB assets retain their selected scene, node hierarchy, primitives, PBR
materials, skins and clips. Textures include base color, normal, metallic /
roughness, separate occlusion and emission, with UV0/UV1 and glTF sampler
settings. Linear glTF factors convert to the renderer's sRGB API convention.
`mesh.use_materials` defaults to true; entity color tints the imported material.
Set it false to use the component's own material throughout the model.

The standard `animation` component supplies a one-based `clip` (0 is bind pose),
`time` in seconds and `loop`. `previous_clip`, `previous_time`, `previous_loop`
and `blend` describe a crossfade: 0 shows the previous pose, 1 the current pose.
The game updates these values as ordinary state. The renderer has no separate
animation clock; seeking and handoff replay reproduce the pose. Clips support
STEP, LINEAR (shortest quaternion SLERP), and CUBICSPLINE with time-scaled
tangents. Morph weights animate before GPU skinning; up to eight skin influences
per vertex are supported. The same deformation is used for rendering, picking,
selection, shadows and AO.

An `attachment` component names a `target` model entity and a zero-based glTF
`node`. Its own transform is an offset in that posed node's coordinates. Pass
`assets: renderer.assets` into `extractScene` to resolve attachments; the React
editor and player already do this. `assets.modelData(path)` exposes node/clip
names for specialized UIs, while `meshData(path)` supplies flattened bind-pose
geometry for tools. Reloading a model or one of its external binary buffers
preserves the current animation component. Imported textures reload too.

Feel Lab's original `assets/models/runner.glb` is generated by
`scripts/character.ts` in that example. Blot chooses Idle, Walk or Jump from
runner state and animates a beacon attached to the left hand.
`deno task test:animation` compares GPU deformation against CPU geometry and
drives those states in Chromium, checking exact pictures after timeline seeks,
handoff replay and asset reload.

The composite pass (`post/chain.ts`, `shaders/post_tonemap.ts`) does, in order:
bloom mix, exposure (manual EV x adapted), grading (temperature, contrast around
mid grey in log space, saturation), tonemapper, vignette, film grain (animated
blue noise, mid-tone weighted), the flat background where the scene did not
cover a pixel, then the overlay layer on top. Unlit and wireframe shading bypass
all of it (colours show as authored; no bloom, exposure, vignette or grain).

Passes at 1280x720 (fixture scene, `view.stats.passes`): high 22 = main, decode,
11 for bloom, composite + 4 sun cascades + 4 for AO, plus overlay + mask + final
(+5 with auto exposure); low 4 = main, composite + 2 cascades. A frame that
changes nothing the shadow maps and AO depend on (static scene and camera) draws
14 / 2: the cascade, local-light and AO passes are skipped (see "Shadows and
ambient occlusion").

### Imported assets: KTX2, meshopt and level of detail

The dev server and `ink build` import assets (`docs/assets.md`); the renderer
reads what they write. `parseGltf` accepts `EXT_meshopt_compression` buffer
views (decoded with `meshoptimizer/decoder`, quantised normals and positions
arrive as ordinary floats), `KHR_texture_basisu` image sources, and the
`INK_mesh_lods` primitive extension. Images embedded in a glTF are registered
under a content-derived `embedded:` URI instead of a base64 data URL, so an
unchanged texture is not uploaded again when a model reloads, and textures a
reload dropped are released.

Textures that start with the KTX2 magic (any path, whatever the extension) go
through `ktx2.ts`. Basis Universal files (ETC1S, UASTC) are transcoded in a
worker by the vendored transcoder (`vendor/basis`, Apache-2.0) to BC7, ASTC 4x4
or ETC2, whichever the device exposes (`createRenderer` requests
`texture-compression-bc|astc|etc2` when the adapter has them), and to RGBA8
otherwise; uncompressed RGBA8 files carry the importer's preview mips and are
uploaded as is. Colour is `*-srgb`, normal/ORM maps are linear, chosen by usage
as before. Block formats need a top level that is a multiple of four; the
importer guarantees it. `assets.textureColor` for compressed files comes from a
small transcoded level.

A primitive with `GpuMesh.lods` draws the coarsest simplified index buffer whose
geometric error projects to under 1.5 pixels (`lod.ts`, `LOD_PIXELS`), picked
per instance in `buildPlan` from the camera and viewport height, so batches are
split by level and a capture depends only on camera and size. Levels share the
primitive's vertex buffer (sparse simplification). Skinned and morphed
primitives have none. Shadows, picking and the transparent pass draw the same
level as the colour pass. A model's merged bind-pose geometry (used for
`meshData`, snapping and bounds) stays on the CPU until something draws the
model path directly.

`renderThumbnail(renderer, { mesh, material? })` draws a 128 px still of a mesh
or of one glTF material on a sphere in a neutral studio (gradient sky, one key
light, no AO/bloom/grain) with an offscreen view; the asset browser caches the
PNG on the dev server by content hash.

### Large worlds: terrain and scatter

`RenderScene.terrains` / `scatters` (from the standard `terrain` and `scatter`
components) draw a heightfield and tens of thousands of instances; see
`docs/terrain.md` for the design. In short: `renderer.assets.terrain(path)` /
`.scatter(path)` return the shared CPU data (`TerrainResource`,
`ScatterResource`: streaming load, strokes with undo, dirty rectangles);
`TerrainGpu` owns the height/slope/splat textures and a CDLOD quadtree;
`ScatterLayer` culls resident placements in a compute pass (frustum, sun
cascades, distance, last frame's depth pyramid, mesh level) into indirect draws.
`Overlays.culling` selects `none | frustum | occlusion`, `View.stats` has
`terrainPatches`, `View.scatterCounts()` reads instance counts back, and
`Assets.memoryBudget` bounds resident meshes and textures. Terrain needs a
camera far plane beyond its size (editor perspective cameras use 6000 m).

### Environment

`extractScene` reads the first active `environment` component into
`scene.environment` (`Environment`, every field typed; defaults mirror the
schema and a test keeps them in sync). `Overlays.environment` overrides fields
per view. Fields: sky (`procedural | gradient | flat`) and its
colours/intensity, ambient, ambientOcclusion, aoRadius, shadowDistance, exposure
(EV), autoExposure, tonemap (`aces | agx | neutral | reinhard | linear`), bloom,
contrast, saturation, temperature, vignette, grain, fog (density, colour,
height, falloff: exponential height fog, also over the sky).

### Sky, image-based lighting and fog

`sky = "procedural"` is a single-scattering atmosphere (Rayleigh, Mie, ozone;
`sky_model.ts`, `shaders/sky.ts`) driven by the **sun: the first directional
light** (direction and colour x intensity). It gives a blue day, orange sunsets,
a purple twilight after the sun has set, a hazy horizon, a limb-darkened sun
disk (twice its real size) and, at night, a dark blue sky with hashed stars.
Below the horizon the sky continues as the lit `ground_color`. `sky_intensity`
scales all of it. A scene with lights but no directional one has no sun (night
sky); a scene with no lights at all gets the default sun. The sun **light's
colour is matched to the sky**: the author's colour times the atmosphere's
transmittance at the sun's elevation, relative to the sun overhead (a sun at the
zenith keeps the authored colour; a low sun is orange and dim; below the horizon
it fades out). Gradient and flat skies leave the light alone and show the
author's colours (orthographic views always show the gradient).

`sky_altitude` sets the world's base altitude in metres; the camera height is
added and quantized to 10 m for the atmosphere bake. `cloud_coverage`,
`cloud_height`, `cloud_scale` and `cloud_offset` control a procedural cloud
layer. Animate the offset in game state for clouds that rewind and capture
deterministically. Direct sun scattering in height fog samples cascaded shadow
maps along the view ray; ambient fog stays lit.

Every sky is also a light. `systems/environment_light.ts` bakes the active sky
into an environment cube (rgba16float, mips), convolves a GGX-prefiltered
specular cube from it (one roughness per mip, filtered importance sampling: no
fireflies), projects 9 spherical-harmonic coefficients (GPU reduction, copied
into `frame.sh` each frame) and makes the split-sum BRDF lookup once per device
(rgba16float 128x128). `ambient` scales the result when shading, so it is never
baked. The cubes leave out the sun disk and the stars (the direct light is the
sun); reflections of a normal-mapped surface fade where they point below the
geometric surface (`horizonOcclusion`).

**When it regenerates:** only when something the sky depends on changes: sky
kind, colours, intensity, sun direction or colour x intensity, observer
altitude, cloud settings, or quality (which reallocates). Horizontal camera
movement, ambient, exposure, fog and lights other than the sun never rebake.
`view.stats.environmentBakes` counts bakes. Unlit and wireframe shading and an
`Overlays.ambient` override skip it and use the hemisphere colours.

| quality | environment | specular | prefilter samples | sky steps | updates                                                    |
| ------- | ----------- | -------- | ----------------- | --------- | ---------------------------------------------------------- |
| high    | 256         | 128      | 96                | 16        | on every change                                            |
| low     | 64          | 32       | 24                | 10        | at most every 8 frames (pending changes are applied later) |

A bake is one compute pass (about 25 dispatches at high: bake, 8 mip
downsamples, 8 prefilter mips, SH); it adds no render passes.

**Fog** is exponential height fog (`fog_density`, `fog_height`, `fog_falloff`),
applied to meshes and to the sky alike. Its colour: a **procedural sky tints the
fog** with a blurred look at the sky towards the horizon in the view direction
(so distance fades into the sky, warm towards a sunset), unless `fog_color` has
alpha above 0, which is an explicit colour (the schema default has alpha 0 =
automatic; other skies use the colour as is). On top, fog scatters the sun
forward: a glow around the sun direction in the sun light's colour (orange at
sunset, gone at night) that grows with the fog's opacity. Low quality has the
same fog.

`Overlays.quality` (`"low" | "high"`, default from
`createRenderer({ quality })`, which itself defaults to `"low"` on software
rasterizers such as SwiftShader): low has no bloom, no auto exposure and no AO,
two 1024 sun cascades instead of four 2048 ones, 12 instead of 32 shadow taps,
smaller local shadow maps and a smaller budget (2 spot + 1 point lights instead
of 8 + 4); the composite pass is the only post pass.

Auto exposure reduces the HDR image to its average log2 luminance (8x8 steps,
about 4 passes), adapts a 1x1 exposure texture per view over time (faster to
brighten the picture than to darken it) and aims at 0.18; the manual EV is added
on top as compensation.

### Shadows and ambient occlusion

**Sun** (`systems/shadows.ts`, `sunShadow`): up to four directional lights with
`shadows` each get 4 cascades (2 at low) in one depth array. Casters are culled
against each cascade, including its extended upstream volume. The view's depth
range (camera near to `shadow_distance`, cut short at the scene's far corner) is
split by the practical scheme (75% logarithmic, 25% uniform; uniform for
orthographic cameras). Each cascade is an orthographic map fitted to the
bounding sphere of its slice (a sphere does not change size when the camera
turns), widened by 20% and quantized, with its origin snapped to whole texels,
so shadow edges do not swim or shimmer. The near plane reaches back to include
casters between the slice and the light. The shader takes the finest cascade
that contains the point (not a slice test), blends into the next one over the
outer 15% of the map and fades out at `shadow_distance` (perspective views).
Orthographic editor views work the same with a box instead of a frustum.
`planCascades`, `cascadeSplits` are exported for tests.

**Bias** (all shadows): the receiver is pushed along its normal by 1 to 2.5
shadow texels, and every filter tap compares against the depth of the receiver
_plane_ at the tap's own position (exact for planar surfaces), minus half a
texel. There is no constant depth bias, so shadows stay attached to their
casters (no peter-panning) and wide kernels do not self-shadow.

**Softness**: PCSS. A blocker search over the map (12 blue-noise rotated Vogel
taps at high) gives the average blocker depth; the penumbra width follows by
similar triangles, so a shadow is hard at contact and softens with distance from
the occluder. The sun is a disc with tan(angle) = 0.06 x `softness`; local
lights are discs of 0.25 m x `softness`. The filter is 32 (high) / 12 (low)
hardware bilinear compare taps in a Vogel disc rotated per pixel by blue noise.
`softness` 0 skips the search and filters 4 taps over under a texel (a hard edge
that is still anti-aliased).

**Spot and point lights** (`systems/local_shadows.ts`): shadow-casting local
lights compete for a budget (8 spot + 4 point at high, 2 + 1 at low), ranked by
`range / distance to the camera` (lights behind the camera count a fifth;
already shadowed lights get a 25% bonus so slots do not flicker). Lights whose
range misses every caster are skipped. The slot is written to
`lights[i].extra.z` (a record in the `shadowMatrices` buffer, layout in
`shaders/shadows.ts`); lights without one are unshadowed. Spot lights render a
perspective map (cone angle plus 2%, at most 150 degrees) into a tile of one
atlas (1024 px tiles high, 512 low) in a single pass; point lights render six 90
degree faces into a cube array (512 high, 256 low; the cube layout is the
hardware's, left handed). Both store hardware depth; the bias maths converts to
linear distance. Point blockers are found through binding 13, the same texture
as plain layers (cube maps cannot be loaded), so point lights get
contact-hardening penumbrae too. A light's map is re-rendered only when the
light or a caster moved (a hash of the caster matrices and mesh buffers); the
atlas is redrawn as a whole when any of its tiles changes.

**Ambient occlusion** (`systems/ao.ts`, `shaders/ao.ts`, high quality only):
ground-truth AO (Jimenez et al., the XeGTAO formulation) at half resolution.
Passes: a prepass of the whole plan (world normal + view depth, rgba32float and
a transient depth buffer), the GTAO pass (3 slices x 6 steps per side, slices
rotated by blue noise, distances squared, samples fade to nothing at the radius)
and two bilateral blur passes (9 taps, weighted by distance to the tangent plane
and by normal). The result (rg16float: visibility, view depth) is bound at 5;
`ambientOcclusion(frag, world)` upsamples it with depth-aware bilinear weights,
so edges do not halo. The light loop applies `ambient_occlusion` as an exponent
(`ao ^ strength`), multi-bounce for the diffuse ambient (brighter albedo, less
occlusion) and Lagarde's specular occlusion for the ambient specular, both times
the material's own occlusion. `ao_radius` is in metres (capped at 80 half-res
pixels). The passes are skipped while the camera and the geometry are unchanged.

**Costs** (4080, 1280x720, indoor test level with 2 point + 1 spot lights;
wall-clock CPU+GPU of a frame loop, noisy on a loaded machine): 3 to 6 ms with
everything, within noise of the same frame without shadows and AO. Pass counts:
sun 4 (2), spots 1, points 6 each, AO 4 (0), all skipped when nothing changed
(static camera: 14 passes in total instead of 35 for the indoor level).

**Debug views**: `Overlays.debug`: `"cascades"` tints the surface by cascade
(red, green, blue, yellow), `"ao"` shows the AO factor (strength and material
occlusion applied, doubled before tonemapping), `"shadow-atlas"` draws the sun
cascades (top row) and the spot atlas (below) as insets in the overlay layer.
Depth is shown white = empty.

### Materials

Mesh fields: `texture` (sRGB), `normal_map` (tangent space, OpenGL +Y up,
linear; tangent frame from screen-space derivatives, no tangent attribute),
`normal_strength`, `orm_map` (R occlusion, G roughness, B metallic; multiplies
the scalar values; linear), `emissive` x `emissive_strength` (HDR: above 1 glows
into bloom), `uv_scale`. The asset store decides the texture format by usage: a
path used as `normal_map` or `orm_map` is uploaded linear, as `texture` sRGB; a
path used both ways is uploaded twice (`assets.getTexture(path, kind)`).
`builtin:` textures (`builtinTextures` in `@ink/schema`) are generated from
`@ink/geometry` (`builtinTexture`) on first use. One shared 64x64 blue-noise
texture (r8unorm) is bound to every scene shader (`blueNoise(pixel)`,
`blueNoiseAnimated(pixel, frame)`) and used for dithering, grain and the shadow
filter rotation.

Lights live in a storage buffer (max 4096; the sun first, then other
directional, then point and spot). Above eight lights a compute pass culls range
spheres into view-space clusters: roughly 64-pixel tiles (up to 32 × 32), with
24 logarithmic depth slices for perspective and linear slices for orthographic
views. Each fragment evaluates its cluster's ascending light indices. Dense
clusters containing more than 64 lights use the complete loop, preserving all
contributions. Directional and unlimited-range lights enter every cluster.
`softness` is carried to the GPU (`extra.y`) and scales the light's size for
soft shadows. `Overlays.clustered = false` selects the reference loop;
`view.stats.lights` and `clusters` report the active counts. Small-light and
unlit views release their cluster storage. Selected light gizmos show ranges in
world units even under scaled parents.

## Beyond the base API

- `assets.settled()`: resolves when every load started so far has finished or
  failed.
- `assets.setTexture(path, { width, height, data })`: raw RGBA8 textures (Deno
  has no `copyExternalImageToTexture`, so file textures only load in browsers).
  The bytes are sRGB as colour, linear as normal/ORM map.
- `view.readPixels()`: raw RGBA8 of the last frame. `view.stats.passes`: render
  passes of the last frame.
- `lookAtCamera(eye, target, settings, aspect)`, `worldMatrices(world)`,
  `sceneGizmos(scene, { selection })` (light/camera/probe lines for
  `Overlays.lines`), `encodePng`, `parseGltf`, `parseObj`, `defaultEnvironment`,
  `resolveEnvironment`.
- `renderer.lost` resolves (does not reject) with the loss info; views then do
  nothing.
- Views re-render themselves when an asset finishes loading.

## Source map

```
renderer.ts view.ts          renderer / one view's frame
frame.ts                     frame uniform + light buffer packing
environment.ts               Environment defaults, extraction, derived colours
systems.ts systems/*.ts      render systems (shadows, AO, environment light)
post/*.ts                    post chain: decode, exposure, bloom, composite
assets.ts plan.ts lod.ts     textures/meshes, instancing batches, LOD choice
ktx2*.ts vendor/basis        KTX2 reading and Basis transcoding (worker)
thumbnail.ts                 asset browser thumbnails
shaders/common.ts            group 0 declarations (frame, lights, extension slots)
shaders/frame_layout.ts      the Frame struct, generated WGSL + TS offsets
shaders/lighting.ts          BRDF + light loop (calls the hooks)
shaders/shadows.ts ao.ts environment.ts   the hook functions
shaders/sky.ts ibl.ts sky_model.ts         atmosphere, IBL compute passes, sun constants
shaders/scene.ts             mesh/sky/pick/mask entry points
sprites.ts layout2d.ts       the 2D layer: GPU resources and draws; resolved items
shaders/sprites.ts font.ts   sprite, tile and text shaders with 2D light; the SDF font
atlas_store.ts gizmos2d.ts   atlas files by path; editor outlines of 2D content
shaders/post_*.ts final.ts   post and final passes
```

## Extension points

Two agents extend the renderer without restructuring it: **shadows + AO** and
**sky + image-based lighting + fog**. Everything they need is reserved.

### WGSL hooks

All are plain functions in the scene shader module with default bodies; replace
the bodies, keep the signatures. `frag` is `@builtin(position).xy` (device px),
`n` the shading normal (after normal mapping, facing the viewer), `nl` =
max(dot(n, l), 0).

| Hook                                                      | File                     | Called by                                                   | Default                                         |
| --------------------------------------------------------- | ------------------------ | ----------------------------------------------------------- | ----------------------------------------------- |
| `sunShadow(world, n, nl, frag) -> f32`                    | `shaders/shadows.ts`     | light 0 when `frame.params.z > 0.5`                         | cascades, blue-noise Vogel PCF, PCSS            |
| `localShadow(lightIndex: i32, world, n, nl, frag) -> f32` | `shaders/shadows.ts`     | any other light with `lights[i].extra.z >= 0` (shadow slot) | spot atlas tile or point cube, PCF, PCSS        |
| `ambientOcclusion(frag, world) -> f32`                    | `shaders/ao.ts`          | `shadeSurface`; strength `frame.envInfo.y`                  | depth-aware upsample of `aoTexture`, else 1     |
| `skyRadiance(dir) -> vec3f`                               | `shaders/environment.ts` | `fsSky`                                                     | baked sky + sun disk + stars; gradient fallback |
| `ambientDiffuse(n) -> vec3f`                              | `shaders/environment.ts` | `shadeSurface` (times albedo)                               | SH irradiance; hemisphere when `systems.z` is 0 |
| `ambientSpecular(r, roughness, nv) -> vec3f`              | `shaders/environment.ts` | `shadeSurface` (times `environmentBrdf`)                    | prefiltered cube, lod = roughness x (mips - 1)  |
| `environmentBrdf(f0, roughness, nv) -> vec3f`             | `shaders/environment.ts` | `shadeSurface`                                              | `brdfLut`; Karis analytic fit as fallback       |
| `horizonOcclusion(r, ng) -> f32`                          | `shaders/environment.ts` | `shadeSurface` (times the ambient specular)                 | `saturate(1 + 1.3 dot(r, ng))^2`                |
| `applyFog(color, world, viewDir) -> vec3f`                | `shaders/environment.ts` | `fs`, `fsSky` (`viewDir`: camera to world, normalised)      | height fog, sky-tinted, sun in-scattering       |

`shadeSurface(Surface)` in `shaders/lighting.ts` is the light loop: per light
`evaluateLight` (GGX/Smith/Schlick, range window, spot cone, shadow hooks), then
ambient (diffuse x multi-bounce `ambientOcclusion`, specular x specular
occlusion, both x material occlusion), then emission. `debugView` ends it.

### Frame group (group 0)

Declared in `shaders/common.ts`, laid out in `pipelines.ts` (`frameLayout`),
bound in `ViewImpl.makeFrameGroup`. Slots without a system use a dummy
(`resources.ts`), so shaders may always read them; the `frame.systems` flags
tell whether a real resource is bound.

| Binding | WGSL name          | Type                             | Owner                 | Notes                                                                             |
| ------- | ------------------ | -------------------------------- | --------------------- | --------------------------------------------------------------------------------- |
| 0       | `frame`            | uniform `Frame`                  | core                  | `shaders/frame_layout.ts` generates struct and TS offsets                         |
| 1       | `sunShadowMap`     | `texture_depth_2d_array`         | shadows (sun, B)      | layer per cascade (4 x 2048 high, 2 x 1024 low)                                   |
| 2       | `shadowSampler`    | `sampler_comparison`             | core                  | linear, `less-equal`                                                              |
| 3       | `spotShadowAtlas`  | `texture_depth_2d`               | shadows (spot, B)     | atlas of tiles; dummy 1x1                                                         |
| 4       | `pointShadowCubes` | `texture_depth_cube_array`       | shadows (point, B)    | cube per point light; dummy: one 1x1 cube                                         |
| 5       | `aoTexture`        | `texture_2d<f32>`                | AO (B)                | half resolution rg16float: r visibility (1 = open), g view depth; dummy white     |
| 6       | `linearSampler`    | `sampler`                        | core                  | linear, clamp                                                                     |
| 7       | `environmentCube`  | `texture_cube<f32>`              | environment light (C) | filterable float (rgba16float)                                                    |
| 8       | `specularCube`     | `texture_cube<f32>`              | environment light (C) | prefiltered GGX, mips = roughness                                                 |
| 9       | `brdfLut`          | `texture_2d<f32>`                | environment light (C) | x scale, y bias; dummy (1, 0)                                                     |
| 10      | `blueNoiseTexture` | `texture_2d<f32>`                | core                  | 64x64 r8unorm; `blueNoise(pixel)`                                                 |
| 11      | `lights`           | `array<Light>` (storage, read)   | core                  | 4096 x 64 B; `extra`: x cos inner, y softness, z shadow slot (-1 none), w free    |
| 12      | `shadowMatrices`   | `array<mat4x4f>` (storage, read) | shadows (B)           | room for 256 matrices (`MAX_SHADOW_MATRICES`); upload via `ctx.shadowMatrices`    |
| 13      | `pointShadowFaces` | `texture_depth_2d_array`         | shadows (point, B)    | the point cubes as plain layers (6 per cube) for `textureLoad`                    |
| 14      | `lightClusters`    | `array<u32>` (storage, read)     | clustered lighting    | count plus 64 ascending indices per cluster; overflow falls back to the full loop |
| 15      | `lightmap`         | `texture_2d<f32>`                | bounce lighting       | padded brush-face atlas, rgba16float                                              |
| 16      | `lightmapCharts`   | `array<Chart>` (storage, read)   | bounce lighting       | world-space chart bases and atlas offsets                                         |
| 17      | `probeCubes`       | `texture_cube_array<f32>`        | reflections           | local GGX-prefiltered radiance                                                    |
| 18      | `probes`           | `array<Probe>` (storage, read)   | reflections           | box transforms, bounds, blend and intensity                                       |

Group 1 contains the five material textures and their samplers. Group 2 contains
instance records, skin palettes and morph targets/weights.

Frame uniform fields reserved for the systems (`frame_layout.ts`): `cascades`
(16 matrices: four lights × four cascades, world to clip space), `cascadeSplits`
(far view distance of each), `shadow` (x map size, y cascade count, z filter
taps, w blocker search taps), `debug` (x: `Overlays.debug` mode), `time.z` AO
radius, `time.w` shadow distance, `envInfo` (ambient, AO strength, sky kind, sky
intensity), `systems` flags (x sun shadow, y AO texture, z environment cubes, w
local shadows). Add fields to the list in `frame_layout.ts`; both sides follow.

### TypeScript interface

`systems.ts` defines `RenderSystem`:

```ts
interface RenderSystem {
  name: string;
  prepare?(ctx: PrepareContext): void; // CPU: write frame.data / frame.lights
  bindings(): SystemBindings; // texture views and the cluster buffer
  encode(ctx: FrameContext): number | void; // record passes before the main
  // pass; returns how many (for view.stats.passes)
  drawOverlay?(pass: GPURenderPassEncoder, ctx: FrameContext): void;
  dispose(): void;
}
```

`PrepareContext` has the scene, camera, overlays, resolved `environment`,
`quality`, `frame` (uniform data, ordered lights, sun, caster bounds),
`write(field, values, at)`, the `shadowMatrices` buffer and the view size.
`FrameContext` adds the encoder, the `plan` (batches), `neutralGroup` (a frame
group with all extension slots on dummies: use it as group 0 in any pass that
renders into a system's own textures) and `instanceGroup`;
`drawPlan(pass, ctx,
{ filter, material })` draws the batches with whatever mesh
pipeline is set.

A view owns one system per slot, in `ViewImpl` (`this.systems`):

| Slot              | File                           | State today                                                    |
| ----------------- | ------------------------------ | -------------------------------------------------------------- |
| sun shadow        | `systems/shadows.ts`           | working: cascades, snapped, PCSS (`planCascades`)              |
| local shadows     | `systems/local_shadows.ts`     | working: spot atlas and point cubes within a budget            |
| ambient occlusion | `systems/ao.ts`                | working: prepass, GTAO, bilateral blur at half resolution      |
| environment light | `systems/environment_light.ts` | working: sky bake, GGX cube, SH, BRDF lookup, sun light colour |

Shadow maps are drawn by `ShadowPasses` (`systems/shadow_common.ts`): one
depth-only pipeline whose group 0 is a dynamic-offset uniform with the pass's
matrix (the frame group is not needed), and `casterSignature(plan)` hashes the
casters so a system can skip a map nothing changed in. Systems that render into
their own textures use `ctx.neutralGroup` as group 0 (real frame uniform, dummy
extension slots), as the AO prepass does. `EnvironmentLightSystem` is done (see
"Sky, image-based lighting and fog"); it also writes `sunDir`, `sunColor`,
`sunTrans`, `sunLight`, `skyInfo` and `sh` in the frame uniform and copies the
GPU-computed SH into it through `FrameContext.frameBuffer`. New pipelines that
read group 0 use `pipelines.frameLayout`; new passes that write HDR use
`COLOR_FORMAT` and must return `hdrOut(color)` (the main target is stored
tonemap-weighted).

## Limits

glTF imports triangle surfaces (triangles, strips and fans), two UV sets, up to
eight skin influences per vertex, morph positions/normals, and the
`KHR_materials_unlit` / `KHR_materials_emissive_strength` extensions. Other
required extensions fail visibly instead of silently dropping data. Optional
unsupported extensions use their glTF fallback. Points/lines and glTF cameras
are not instantiated; cameras and lights are Ink scene components. Normal-map
tangents derive from the deformed surface and its UVs. At most four directional
lights cast cascaded shadows, and at most 8 spot + 4 point lights cast shadows
(2 + 1 at low quality); shadow-casting spot lights wider than 150 degrees lose
their shadow outside that cone. Shadow maps for local lights draw every caster
into each map that is redrawn; directional cascades cull individual instances.
There are no contact shadows. AO needs a depth and normal prepass of the whole
scene, sees geometry only (no thin-occluder heuristic), and is off at low
quality. Image-based lighting has no reflection probes or screen-space
reflections: every surface reflects the sky, never the scene. Clouds use a
procedural layer, without volumetric lighting or cloud shadows on geometry;
atmospheric multiple scattering is an approximation. Spot culling uses
conservative range spheres; shadow budgets remain separate from the lighting
limit. Outlines do not show through occluders. Brush UVs: 64 texels per metre at
scale 1. HDR radiance is clamped to 512 and stored in float16 weighted form, so
values far above 100 lose a few percent of precision.
