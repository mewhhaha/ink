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
overlay pass  4x MSAA rgba8unorm-srgb, premultiplied: grid, face fills, lines.
              Depth-tested read-only against the scene depth. Skipped when
              there is nothing to draw. Never exposed, tonemapped or bloomed.
post          decode -> [auto exposure] -> [bloom] -> composite
mask pass     selection / hover mask, depth-tested (only when flagged)
final pass    selection outline, sRGB encode, blue-noise dither
```

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
  `sceneGizmos(scene, { selection })` (light/camera lines for `Overlays.lines`),
  `encodePng`, `parseGltf`, `parseObj`, `defaultEnvironment`,
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
assets.ts plan.ts            textures/meshes, instancing batches
shaders/common.ts            group 0 declarations (frame, lights, extension slots)
shaders/frame_layout.ts      the Frame struct, generated WGSL + TS offsets
shaders/lighting.ts          BRDF + light loop (calls the hooks)
shaders/shadows.ts ao.ts environment.ts   the hook functions
shaders/sky.ts ibl.ts sky_model.ts         atmosphere, IBL compute passes, sun constants
shaders/scene.ts             mesh/sky/pick/mask entry points
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

Group 1 is the material (sampler, base, normal, ORM); group 2 the instance
buffer.

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

glTF: first mesh only, primitives merged, node transforms and materials ignored.
At most four directional lights cast cascaded shadows, and at most 8 spot + 4
point lights cast shadows (2 + 1 at low quality); shadow-casting spot lights
wider than 150 degrees lose their shadow outside that cone. Shadow maps for
local lights draw every caster into each map that is redrawn; directional
cascades cull individual instances. There are no contact shadows. AO needs a
depth and normal prepass of the whole scene, sees geometry only (no
thin-occluder heuristic), and is off at low quality. Image-based lighting has no
reflection probes or screen-space reflections: every surface reflects the sky,
never the scene. Clouds use a procedural layer, without volumetric lighting or
cloud shadows on geometry; atmospheric multiple scattering is an approximation.
Spot culling uses conservative range spheres; shadow budgets remain separate
from the lighting limit. Transparency is not supported. Outlines do not show
through occluders. Brush UVs: 64 texels per metre at scale 1. HDR radiance is
clamped to 512 and stored in float16 weighted form, so values far above 100 lose
a few percent of precision.
