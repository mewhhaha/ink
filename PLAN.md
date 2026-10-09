# Twenty hills

See `CONTINUE.md` for where the work stopped and what comes next.

The rewrite on Blot2 stands: schema → generated Blot → pure `step`, one session
for edit and play, hot reload of code/schema/assets/scenes/UI, React building
blocks, a WebGPU renderer, brush tools, comments, hand-offs and headless
captures, proven by four example editors. These are the next hills, roughly in
the order they unlock each other. Each names its first executable boundary and
the gate that says it is done. The lighting baseline is in place: HDR with auto
exposure, bloom, tonemapping and grading; cascaded, spot and point shadows with
contact-hardening penumbrae; GTAO; a physical sky with image-based light; height
fog with sun in-scattering; normal and ORM maps; noise textures.

## Completed follow-up (2026-10-08)

- **Capture stability.** Reproduced the pink/green SwiftShader frames and traced
  them to compute sampling of cube borders: the source texels were finite, but
  sampled radiance and the resulting SH/reflection bake contained NaNs. The bake
  now reads 2D array faces, filtering across face edges explicitly. Still
  captures also bypass the low-quality sky-bake throttle. Captures dispose their
  offscreen views again instead of caching one per size. `deno task test:render`
  checks fresh views, repeated captures, the first frame after resize (including
  odd and one-pixel sizes), changed skies, and local-shadow texture lifetimes in
  Chromium/SwiftShader, and writes pictures under `tmp/`. The same checks run
  with Deno WebGPU. All 106 package tests, the 50-test renderer suite on an RTX
  4080 SUPER, and browser smoke checks for all four editors passed.
- **Local-shadow memory.** Unused spot atlases and point cubes are released when
  lights disappear, no casters remain, or shading is unlit/wireframe; active
  textures shrink with the quality budget and rebuild on reactivation.
- **Dev cache isolation.** The CLI defaults Vite's cache to the project's
  `.ink/vite/`, so Deno projects without a `package.json` do not accidentally
  share an ancestor directory's cache. Explicit Vite cache settings still win.

## Loose ends from the first pass

The requested scope includes these fixes and all twenty hills below. A hill is
complete only when its stated gate has been verified.

- **Renderer follow-up implemented.** Procedural layered clouds with a
  deterministic offset, observer altitude, shadowed sun scattering in fog, up to
  four shadowing directional lights, and per-cascade caster culling. Noisy PCSS
  now accumulates with temporal anti-aliasing (hill 8); probes and screen-space
  reflections are implemented in hill 9. Clouds are a layer, not a volumetric
  simulation.
- **Brush follow-up verified in Chromium.** Resize, clip and vertex/edge edits
  support full parent transforms and preserve pivots; clipping works in 2D and
  3D. Marquee selection and dynamic resize cursors work.
  `deno task test:brushes` exercises pointer/key interaction and undo against a
  rotated, scaled parent.
- **Hammer follow-up implemented.** Trigger volumes are invisible convex brushes
  with hierarchy-aware containment. The complete recorded button chain runs in
  the browser, checks both doors and the final game state, and captures ticks
  285, 650 and 944. Capture preserves the current live world. Recorded inputs
  now use the session timeline; branching after rewind restores time.
- **Dev CLI follow-up implemented.** Public `@ink/dev/node` and `catalog`
  exports replace private imports. All workspace packages are excluded from
  dependency prebundling, and uncaught page errors fail capture. The historical
  missing-InkApp error did not reproduce in the current checkout.
- **Compiler quirks reported.** Both failures and passing workarounds were
  reproduced against Blot2 `6db786f` and filed as
  [blot2#8](https://github.com/mewhhaha/blot2/issues/8). Fixes remain upstream.
- **Hardware browser verified.** The capture, resize, sky/cloud and resource
  lifetime checks pass in headed Chromium on NVIDIA WebGPU, with no fallback.
  Use `deno run -A scripts/render-smoke.ts --hardware --headed`; the sandboxed
  task launcher could not access the same GPU. The first integration check
  passed `deno task check` and all 111 package tests.

## Runtime

1. **Keep the world in the guest.** Today every step copies, decodes and
   re-encodes the whole world (~0.4 ms per 1,000 entities). Keep state in Wasm
   memory across steps (a suspended `for ever` loop or stateful entries),
   transfer only changed entities, decode on the host lazily. _Done when_ 20,000
   entities step at 60 Hz with snapshots, rewind and hot reload unchanged, and
   headless runs give byte-identical states.

   **Implemented and verified (2026-10-09).** The step stays a stateless pure
   function of the host-owned packet. Keeping the decoded world in a
   JSPI-suspended `for ever` loop was measured and rejected
   (`scripts/guest-loop-bench.ts`): at 20,000 entities it costs 2 to 3 times
   less on average than a stateless step while a fifth or fewer move, but one
   step in four is a 22 to 29 ms collection, it is 2 to 3 times slower when
   everything moves, and Firefox and Safari lack JSPI. What changed instead: the
   generated codec writes the result packet in place (decode plus encode fell
   from about 13.5 to 5.6 ms at 20,000 entities); `decodeWorld` is lazy above
   1,024 entities (`PackedEntity` decodes a component on first use,
   `hasComponent`/`componentOf` read the packet, untouched entities re-encode
   verbatim, so a live edit costs 6 ms instead of 380); keyframes stay zero-copy
   but are spaced by state size and bounded by bytes (rewinding 45 ticks: 3.7 s
   to 81 ms); the outliner is windowed and linear,
   `Session.structure`/`entity(id)` replace linear scans, the rollback hash
   reads words, scene extraction allocates less, and `advance` gives up catching
   up after 20 ms. Back to back on a machine at load average 30, a 20,000-entity
   session step with 4,000 movers went from 29 to 12 ms (quiet machine: 6 to 8
   ms for the guest call, 12 to 15 ms with all 20,000 moving), and the Chromium
   editor on an RTX 4080 SUPER from 3.8 to 10.4 steps per second with every
   panel mounted, now bound by the renderer's 46 ms of CPU for 20,000 draws
   (hill 10). `deno task bench:world --browser [--hardware --headed]` also
   checks that the headless Deno run, a session after rewinding and Chromium
   reach the same state hash after 40 ticks at 1,000, 5,000 and 20,000 entities.
   Passing against Blot2 86a527b in a clean snapshot: unit tests, the four
   example scenario suites, and `test:scenarios`, `test:live`, `test:brushes`,
   `test:build`, `test:shared`, `test:browser`, `test:clusters`,
   `test:particles`, `test:animation`, `test:temporal` and `test:gi`;
   `test:multiplayer` passes with the Feel Lab of the previous commit (the
   in-progress physics rewrite moved `runner.grounded`, which that test reads).
   The gate holds with margin when a fifth of 20,000 entities move (quiet
   machine: 6 to 8 ms of a 16.7 ms budget, p95 15.7 ms even at load 30); with
   all 20,000 moving it is 12 to 15 ms, inside the budget without margin. _Not
   done:_ the guest still decodes and encodes every entity each step (5 ns per
   lane); keeping static scenery out of that pass needs a game-facing API.
   Shared CRDT sessions and multiplayer joins were not measured at 20,000
   entities, and a mid-range GPU was not tried.
2. **Physics as a Blot library.** Capsules, boxes and convex hulls; swept
   collision; a character controller with slopes, steps and moving platforms;
   rigid bodies with stable stacking; queries (ray, shape cast, overlap).
   Deterministic, so replays and hand-offs reproduce. _Done when_ the examples
   drop their ad-hoc collision and a test stacks 50 boxes for 10 s with
   identical results across runs.

   **Implemented and verified (2026-10-09).** `ink/physics` (Blot, see
   `docs/physics.md`) provides capsules, boxes and brush hulls; exact
   closest-feature casts and a ray/shape-cast/overlap query API; speculative
   contacts plus inscribed-sphere continuous collision; a soft-step
   sequential-impulse solver with warm starting through a contact cache in the
   world, friction, restitution and island sleeping; and a capsule character
   controller (slopes, steps, ground snapping, moving platforms, wall sliding,
   pushing). The standard `collider`, `body` and `character` components and
   `physics` resource generate `s.physics_step` / `s.physics_scene` glue. Feel
   Lab, Godot, TrenchBroom and Hammer dropped their own collision (`ink/collide`
   is gone) and keep their recorded scenarios and golden images; Godot gained a
   physics scene (pyramid, tower, balls, ramp, fired balls). Viewports have a
   Physics toggle for colliders and contacts.
   `deno test -A
   packages/blot/physics_test.ts` stacks 50 boxes for 600 ticks
   twice with byte-identical states and a standing, sleeping tower, and covers
   queries, slopes, steps, platforms, pushing, bouncing, tunnelling and waking.
   `deno task test:physics` steps Godot's physics scene 300 times in Chromium
   and in Deno and requires identical entity states. 50 and 60 box towers stand
   for 10 s with sleeping disabled (substeps double for chains of twelve bodies
   and quadruple at thirty). Follow-up pass: sleeping bodies leave the broad
   phase (active movers only; a fully settled world skips the step), pair
   sorting is one exact key, the solver reuses jacobians between substeps and
   the contact cache is written in place. `deno task bench:physics` ran on a
   machine whose load average was 30 to 125 (other agents, a game, compilers; an
   idle machine was never available). Before this pass: 50 boxes awake 2.6 ms
   median, 200 mixed bodies settling 17.7 ms, TrenchBroom walk 2.7 ms for the
   whole game step. After: 50 boxes awake 4.3 ms (more substeps while the tower
   is tall), 200 bodies settling 14 ms, a fully settled world 0.07 to 0.4 ms,
   TrenchBroom walk 2.4 ms. The target of 6 ms median for 200 awake bodies is
   not demonstrated: best-of-20 timing of one settling state fell from 18.3 to
   11.7 ms although the load grew. What remains is allocation in the narrow
   phase (per-pair contact lists, polytope vertex records). Chromium/Deno
   agreement was verified on one scene.
3. **Prefabs and nested scenes.** Instances of scene files with per-instance
   overrides, editable in place; materials and other shared data as assets
   (`*.material.json`) the schema can reference; Blot can spawn a prefab by id.
   _Done when_ the TrenchBroom example's doors and crates are prefabs and
   editing the prefab updates every instance live, with overrides kept.
4. **Text, strings and typed TS views.** Generate `schema.gen.ts` so UI code
   gets `World`, components and resources as TypeScript types; localization
   tables for messages; entity names visible to Blot through ids. _Done when_
   the examples' HUDs use typed hooks and a message table switches language at
   runtime.

   **Completed (2026-10-08).** The compiler and `ink gen` emit TypeScript
   records, nested types, enum unions, actions, events, message ids and World.
   All four HUDs use `createSchemaHooks<World>()`. Schema localization tables
   hot reload, fall back to the default text and switch through a language
   control. The browser replay switches Hammer's completed HUD to Polish and
   verifies an unchanged game state. Entity `name_id` symbols survive packets,
   spawning, scenes, rename and undo; declared names generate Blot constants.
   Generated types are checked with both valid and deliberately invalid usages.

## Rendering

5. **Clustered lighting.** Light culling into view-space clusters so hundreds of
   point and spot lights cost what eight do now; light-type icons and ranges in
   editors. _Done when_ 512 lights render at 60 fps on a mid GPU.

   **Implemented and browser verified (2026-10-08).** A compute pass builds
   deterministic view-space light lists for up to 4096 lights, with conservative
   range culling and a complete fallback when more than 64 lights overlap a
   cluster. Small-light views skip the pass. Perspective/orthographic pixel
   comparisons against the full loop pass on NVIDIA, AMD and SwiftShader.
   Editors distinguish light types and show their world-space ranges. At 1280 ×
   720 with 512 moving-view point/spot lights and 128 spheres, the RTX 4080
   SUPER browser measured 4.9 ms median / 9.6 ms p95, versus 3.5 / 5.6 ms for
   eight lights. The 7800X3D integrated GPU measured 25.0 / 26.0 ms, versus 95.6
   / 96.7 ms without clustering. A midrange GPU's 60-fps acceptance remains
   unverified. Run `deno task test:clusters --hardware --headed` or
   `deno run -A scripts/cluster-bench.ts --low-power --require-60`.
6. **Transparency and particles.** Sorted alpha blending, alpha-tested foliage,
   additive effects, and a GPU particle system (compute) whose emitters are
   components and whose bursts are Blot events. _Done when_ fire, smoke and
   sparks run in the Godot example and survive rewind (particles are
   presentation, reseeded from the tick).

   **Completed (2026-10-08).** Meshes support sorted linear-HDR alpha, additive
   light, double-sided surfaces and alpha cutouts shared by rendering, picking,
   shadows and AO. GPU compute reconstructs ballistic particles from tick/seed
   and sorts each emitter by depth. The Godot `particles` scene shows fire,
   smoke, glass and Blot-event spark bursts on Space. A bounded event history
   follows timeline branches and rollback; handoffs retain bursts that started
   before their keyframe. `deno task test:particles` verifies the real scene in
   Chromium/SwiftShader, including identical captures after rewind and handoff
   replay. Emitters support up to 2048 particles each, 64 active batches per
   view and ten-second lifetimes. Transparent objects and emitter batches sort
   by center; intersecting batches retain that usual limitation.
7. **Animated meshes.** Full glTF: node hierarchy, materials, skins and
   animation clips; blending and state machines driven by component values;
   attachment points. _Done when_ a skinned character walks and jumps in the
   Feel Lab with poses following game state and scrubbing the timeline.

   **Completed (2026-10-08).** glTF imports retain their scene hierarchy,
   primitive materials, skins, morph targets and clips. STEP/LINEAR/CUBICSPLINE
   sampling and crossfades use only animation component values. GPU skinning
   supports eight influences; geometry, shadow, AO, selection and pick passes
   share deformation. Feel Lab's original skinned character changes between
   Idle, Walk and Jump in Blot and carries a beacon on its animated hand.
   `deno task test:animation` passed in SwiftShader and NVIDIA Chromium,
   comparing GPU pixels with CPU deformation and reproducing exact character
   pictures after timeline scrubbing, handoff replay and asset reload. See the
   renderer README for supported glTF features and limits.
8. **Temporal anti-aliasing and upscaling.** Motion vectors, TAA with history
   rejection, render-scale upscaling; lets AO, shadows and grain accumulate over
   frames. _Done when_ edges are stable while moving and half-resolution
   rendering looks close to native.

   **Completed (2026-10-09).** Per-view velocity tracks camera, instance, skin
   and morph motion. Jittered frames reconstruct at output resolution with
   Catmull-Rom filtering, depth rejection and neighbourhood clipping;
   transparent surfaces reduce history weight. AO, soft shadows and grain vary
   their samples and accumulate. Viewport/player settings expose TAA and
   100/75/50% resolution; paused views converge and stop drawing.
   `deno task test:temporal` passed on NVIDIA and SwiftShader: half-resolution
   output differed from a supersampled reference by 4.0/255 mean RGB levels, or
   4.8/255 during camera motion. Equivalent rigid, bone and morph motion
   produced identical pixels; grain variance fell to 8.3% of a raw frame.
   Disocclusion, picking, rewind, camera cuts, odd resizing, deterministic
   captures and Feel Lab animation passed. Fine details are softer at 50%;
   transparency has a reactive mask, without its own velocity pass.
9. **Global illumination.** Baked lightmaps for brush levels (path-traced on the
   GPU, rebaked in the background after edits), reflection probes, and
   screen-space reflections. _Done when_ the Hammer level's dark room is lit by
   bounce light from the lamp and rebakes within seconds of a brush edit.

   **Implemented and browser verified (2026-10-09).** GPU path tracing bakes
   static brush charts progressively, with texture-tinted diffuse bounces, BVH
   traversal and deterministic edit/undo. Static box-projected reflection probes
   and screen-space reflections share the renderer's materials and temporal
   accumulation. Hammer has room probes and a polished panel.
   `deno task test:gi` passed in SwiftShader: lamp bounce illuminated 7,054
   previously shadowed pixels, the complete room rebaked after a pillar edit,
   and undo reproduced identical pixels. The software rebake took 18.4 s; the
   hardware timing gate remains unverified because the installed NVIDIA
   driver/library versions disagree (615.71.09 / 615.78). Native GPU fixtures
   passed before that system change. See the renderer README for resolution,
   static-geometry and material limits.
10. **Large worlds.** Heightmap terrain with noise-based detail and splat
    materials, LOD for meshes and terrain, frustum and occlusion culling, asset
    streaming. _Done when_ a 4 km² terrain with 100,000 instances edits and
    plays smoothly.

    **Implemented and browser verified (2026-10-09).** `terrain` and `scatter`
    components keep kilometre-scale data in `*.terrain` / `*.scatter` assets.
    Terrain is a CDLOD quadtree of 32 x 32 patches with vertex texture fetch,
    crack-free morphing, prefiltered slope and splat textures, up to eight
    height-blended layers and noise detail shared bit-for-bit with `ink/noise`
    (TypeScript, WGSL and Blot); it takes cascaded shadows, AO, reflections, TAA
    velocity and picking. Scatter layers cull on the GPU (frustum, cascades,
    distance, last frame's depth pyramid), choose hill 13's mesh levels and draw
    by indirect calls through the unchanged mesh shaders. `@ink/terrain` adds
    sculpt, smooth, flatten, noise, paint and instance tools with undo through
    the scene's revision, saved as byte ranges; `ink/terrain` gives Blot
    `height`/`normal`/`stick` over a coarse grid; terrain tiles, instance chunks
    and a mesh/texture memory budget stream. See `docs/terrain.md`.
    `examples/terrain` is 2049² samples at 1 m (4.2 km²) with 100,000 placements
    and a walker. On an RTX 4080 SUPER in Chromium (1280 x 720, high quality,
    TAA), flying the camera (kept above the ground) measured 11.0 ms median /
    13.6 ms p95 (submit to GPU completion, 300 frames), playing 8.4 / 12.4 ms,
    and raise and paint strokes dragged with the real mouse kept one-vsync frame
    intervals (p95 16.7 ms at 60 Hz); undo restored heights, splat and the saved
    file exactly. A 2049² dab costs 0.1 to 0.5 ms (noise 15 ms).
    `deno task test:terrain` (and
    `deno test -A packages/render/terrain_test.ts`) passed in Deno WebGPU,
    SwiftShader and hardware Chromium; the real scene renders on SwiftShader
    (seconds per frame, pictures only). Not verified: a midrange GPU, other
    vendors, or timing while other GPU jobs run (they doubled p95). Limits: 8192
    instances per level for the camera and 4096 per cascade (extras are
    dropped), no impostors or spot/point shadows from scatter, occlusion lags
    one frame, the game sees only the coarse collision grid, terrain edits made
    outside a session have no undo history, and mesh/texture streaming evicts by
    recency under a byte budget without distance priority.
11. **2D.** Sprites, atlases, tilemaps, 2D lights and SDF text on the same
    session and tools; an orthographic tile editor example. _Done when_ a tile
    platformer is built in an example editor in an afternoon with the same hot
    reload and hand-offs.

    **Completed (2026-10-09).** `standard.components2d` adds `sprite`,
    `tilemap`, `light2d` and `text`; atlas files (`*.atlas.json`) name image
    frames, animations, tile flags and auto-tile rules, and generate `frame_`,
    `anim_` and `tileflags_` constants for Blot. Tile ids are a `cells` list in
    the world, so every tile edit is undoable, timeline-recorded, hand-off-able
    and changes the playing world; see `docs/2d.md` for the packet-size
    trade-off (one lane per cell, up to 32,768 cells). The renderer draws a 2D
    layer first in the overlay pass: instanced nearest-sampled sprites sorted by
    layer/y, one quad per tile map from a tile-id texture, ambient/lamp/spot/sun
    light with atlas normal maps and tile shadows, and scalable outlined SDF
    text from a built-in pixel font generated on the CPU. It is
    display-referred, so TAA and render scale leave it pixel-exact; picking,
    still captures and editor gizmos work. `@ink/tiles` provides the paint,
    erase, rectangle, fill and picker tools, auto-tiling, a tileset palette and
    a layers panel, and `ink/tiles` gives Blot tile lookup and an AABB slide
    with one-way planks, ladders and hazards. `examples/tiles` is a tile editor
    with a platformer (coyote time, jump buffer, ladders, slimes, coins, flag,
    SDF HUD), procedurally drawn art and a recorded playthrough with golden
    images. `deno task test:tiles` builds a level on a blank map with the real
    tools, plays it with a bot and wins, then hot reloads Blot code, the tileset
    image, the atlas file, tiles and the editor's source while playing, and
    checks a capture, a hand-off replay and the scenario (about three minutes
    under SwiftShader). `deno task test:sprites` checks the layer on real pixels
    and passed on SwiftShader and on the RTX 4080 SUPER. Not done: sprites cast
    no shadows (only one solid-tile map per view does), text has only the
    built-in font, tile tools assume unrotated maps, and a map of tens of
    thousands of cells makes the per-step packet copy visible (hill 1 keeps the
    step stateless).

## Iteration

12. **Sub-100 ms everything.** Blot incremental builds under 100 ms on large
    games (with blot2's hills), patching a running guest instead of
    re-instantiating, asset imports in workers, and a frame profiler (guest
    step, decode, extraction, GPU timestamps) always visible. _Done when_ a
    save-to-pixels loop is measured and shown in the editor, and stays under 150
    ms for code and under 50 ms for tuning values.

    **Implemented and measured (2026-10-09); tuning meets its budget, code meets
    it only for a small game.** `session.profiler` records per-frame guest step,
    decode, extraction, render CPU, GPU pass time (WebGPU `timestamp-query`,
    requested when the adapter has it) and frame interval, and a stage-by-stage
    trace of every change from file write to the animation frame after the GPU
    finished it (watcher, debounce, blotc, transport, fetch, Wasm compile,
    warm-up, swap, frame wait, step, extraction, draw, submit, GPU, present),
    tagged with the file. `<FrameProfiler />` shows it in the toolbar of every
    example (click for the panel); `profile` returns it over the live HTTP/MCP
    API and `__ink.profile()`. `deno task test:iteration` edits Blot code, a
    schema default, the scene file, an asset, a component through the live API
    and a typed inspector field in a running editor (play and paused) and prints
    median/p95 and stage medians; with `--hardware --headed` it rejects software
    adapters and asserts 150 ms for code and 50 ms for tuning on the medians.
    Measured on the RTX 4080 SUPER (NVIDIA 615.78.08 works headed; no library
    mismatch seen) with the machine at load average 14 to 30 (a game was using
    the GPU at 96%), medians in ms:

    | Example     | Code | Schema | Scene (play / paused) | Tuning API (play / paused) | Inspector (play / paused) |
    | ----------- | ---: | -----: | --------------------: | -------------------------: | ------------------------: |
    | feel        |  285 |     70 |               34 / 21 |                    29 / 17 |                       n/a |
    | godot       |  332 |     62 |               46 / 41 |                    18 / 21 |                   30 / 22 |
    | tiles       |  129 |     52 |               29 / 43 |                    16 / 20 |                       n/a |
    | trenchbroom |  357 |    n/a |               56 / 26 |                    21 / 18 |                   33 / 22 |
    | hammer      |  242 |    n/a |               39 / 35 |                    18 / 14 |                   28 / 27 |

    Textures edited on disk reach pixels in 38 to 50 ms. The time that is left
    in a code reload is two stages Ink does not own: blotc (Godot 76 ms, Hammer
    49, tiles 31; it grows with the module, 78 to 201 ms for 459 to 827 KB of
    Wasm for the same one-number edit) and V8 compiling the new module's
    functions on their first call (154 to 218 ms for the 330 to 470 KB games, 69
    ms for tiles). Before this work the first call happened on the main thread,
    a 194 ms freeze inside "next step" (Godot, load 63: watch 5, debounce 13,
    blotc 96, fetch 15, step 194, rest 50 = 377 ms); a worker now runs one
    throwaway step of each new module (compiled code is shared with the page),
    so the page keeps running the old game and its first real step takes under 1
    ms, but total latency is the same. Other changes: identical Wasm is not
    transferred or swapped (comments, schema defaults the game never reads),
    modules and small scenes travel inside the HMR event, the watcher debounces
    5 ms and coalesces a truncate-then-write save, repeated identical file
    events do not rebuild, a scene file edited during play also tunes the live
    world, and a change made between frames is drawn at once instead of at the
    next animation frame (tuning 39 to 47 ms before, 18 to 30 ms after).
    Instantiating costs 0.2 ms and a layout-preserving swap migrates nothing, so
    patching a live guest would not help; what would is upstream: Wasm that is
    cheaper for V8 (Godot's has 32,467 locals, one function 69 KB with 4,357),
    per-function patching, and blotc edits proportional to the change
    (`docs/blot.md`, "Build times"). SwiftShader numbers are dominated by
    software rendering and are reported, not asserted: tuning 158 ms (tiles) to
    1.4 s (hammer), code 351 ms (feel) to 3 s (hammer), the GPU stage being
    almost all of it. Gaps: the code budget fails for every example except
    tiles. Every example's scenarios passed against CI's Blot2 revision 86a527b
    after integration.
13. **Asset pipeline.** Import on save: KTX2/Basis texture compression, mipmaps,
    mesh optimisation and LODs, audio transcoding; a content-addressed cache;
    thumbnails for meshes and materials in the asset browser. _Done when_
    dropping a 50 MB glTF into `assets/` is usable in the editor in seconds and
    loads fast in a build.

    **Implemented and browser verified (2026-10-09).** `@ink/assets` imports on
    save in Deno workers (never on the dev server's main thread) into
    `.ink/cache/<sha256>/`, keyed by source bytes, importer version, stage and
    settings; the previous result (or the source) keeps being served until a
    stage finishes, then the existing `ink:asset` path reloads it in place.
    Large assets get a preview stage (seconds: meshopt-compressed geometry, 256
    px raw KTX2 textures with precomputed mips) and a full stage (Basis ETC1S
    colour / UASTC normal+data textures, up to four simplified `INK_mesh_lods`
    levels per static primitive, never for skinned or morphed ones); audio
    becomes Ogg Opus (`opusscript` + our Ogg muxer, ffmpeg only as an optional
    decoder). The renderer transcodes KTX2 in a worker to BC7, ASTC or ETC2
    (RGBA8 where none exists), decodes `EXT_meshopt_compression`, and picks LODs
    by projected error (< 1.5 px). The asset browser shows import progress and
    caches thumbnails of textures, meshes and glTF materials by content hash
    (meshes/materials drawn by the renderer itself). `ink build` ships the
    imported files plus `ink-assets.json`. Gate asset: `scripts/gen-big-gltf.ts`
    (55.6 MB, 896,384 triangles, four PNGs); sizes 55.6 MB to 5.5 MB (preview)
    and 13.6 MB (geometry 25.2 to 6.2 MB, textures 30.4 to 7.4 MB). Dropped into
    a running editor on a loaded machine (load average ~40, SwiftShader):
    catalog entry after 31-47 ms, model parsed and textured assets uploaded
    after 1.1-1.8 s, full quality (2048 px BC7, LODs) after 20-34 s, page timer
    stall at most 0.33 s, dev server request latency at most 0.29 s; the
    unprocessed file took 31 s and stalled the page 3.4 s. On the RTX hardware
    path (`--hardware`, lighter load) the figures are 1.2 s and 24 s versus 1.4
    s for the raw file, so the editor-side win there is memory, stalls and
    reload cost rather than the first draw. Builds: 13.6 MB instead of 55.6 MB
    of assets (16.1 versus 56.4 MB transferred), first frame 1.03 s versus 1.00
    s from localhost on hardware, 32 s versus 75 s on loaded SwiftShader.
    `deno task test:assets` runs the gate (`--only-build`, `--skip-build`,
    `--hardware`); see `docs/assets.md`. Gaps: the full stage is CPU-bound in
    single-threaded wasm (about 12 s idle, 20-34 s under load; ETC1S and UASTC
    encode a 2048 px texture in roughly 6-10 s and 2 s), WebP/Draco/
    already-compressed models are served as they are, Safari Opus support and
    Windows/macOS workers are unverified, textures larger than 12 Mtexels are
    scaled down, and LOD error uses accumulated simplifier error without
    hysteresis.
14. **Editing depth.** Box selection, snapping to surfaces and vertices,
    vertex/edge/face brush editing, brush CSG (subtract, merge), texture lock,
    alignment tools, a visible history panel, rebindable shortcuts. _Done when_
    a TrenchBroom user rebuilds a Quake-sized room without leaving the
    keyboard-and-mouse habits they have.

    **Implemented and browser verified (2026-10-08).** Surface/vertex snapping,
    vertex/edge/face handles, disjoint convex subtraction, convex merge, affine
    texture locking, bounds alignment, visible history and persisted shortcut
    rebinding are available in the brush editors. `deno task test:brushes`
    drives these tools and constructs a 16 × 12 m room from an empty map with
    block/resize/CSG gestures. Parent transforms, undo and UV preservation have
    regression coverage. A TrenchBroom user's usability acceptance remains.
15. **Scenario tests.** Recorded inputs plus assertions on world state and
    golden images, as files beside the game, run headlessly in CI with a GPU (or
    SwiftShader) and shown in the editor's timeline when they fail. _Done when_
    every example ships scenarios and a broken jump shows the failing tick and
    image diff.

    **Completed (2026-10-08).** Every example ships recorded scenarios and PNG
    baselines, run by `ink test`. The editor's Run test control uses the same
    session runner. Failures stop at a checkpoint, preserve the replay and show
    actual/difference images from a red timeline marker. A browser test disables
    jumping and verifies the tick-72 failure and diff. The CLI retains browser
    jobs until GPU work completes and polls their completion, fixing CI's
    collected-promise failures. All four golden suites, the failing-jump UI
    check and live agent workflow passed in
    [GitHub CI](https://github.com/mewhhaha/ink/actions/runs/37823910068), with
    capture artifacts uploaded. See `docs/scenarios.md`.

## Agents and collaboration

16. **The editor as a live agent surface.** An MCP server (and HTTP API) over
    the running session: read the world, apply edits, play, step, capture any
    view, reply to and resolve comments, open hand-offs. Agents see exactly what
    the person sees and changes appear live in their editor. _Done when_ an
    agent fixes a comment end to end — reads it, reproduces it from the replay,
    edits code, captures before/after, resolves it — without the person leaving
    the editor.

    **Completed (2026-10-08).** Every browser registers its real session with
    the dev server. HTTP and MCP expose the world, undoable typed edits, play,
    recorded stepping, mounted-view captures, comments, handoffs and source
    edits guarded by content hashes. `deno task test:live` reports a broken
    jump, reproduces the exact replay, edits the code over MCP, checks the live
    rebuild, captures before/after and resolves the comment in the same editor.
    Multiple browsers require explicit session selection. Disconnects, timeouts,
    stale file edits and cross-origin requests are checked. See
    `docs/agents.md`.
17. **Comments as a workflow.** Threads, assignees, statuses, before/after
    captures attached to replies, comments on timeline ranges and on code lines
    from diagnostics, and a queue an agent can work through. _Done when_ a
    play-test session produces a list of comments an agent burns down overnight
    with captures as proof.

    **Implemented and browser verified (2026-10-08).** Threads have assignees,
    open/in-progress/blocked/resolved states, replay links and before/after
    capture attachments. Every editor has a filterable queue. Timeline ranges
    and compiler diagnostics can create reports with replay and source anchors.
    The live test creates gameplay, range and diagnostic reports and clears the
    queue with persisted capture evidence. An unattended overnight run has not
    been performed.
18. **Multi-user sessions.** Several people (and agents) in one live session: a
    CRDT scene document, presence, per-user selection and cameras, shared
    comments. _Done when_ two browsers edit one level and play it together.

    **Completed (2026-10-08).** Share scene connects up to sixteen editors to a
    durable CRDT document. Field registers merge concurrent edits; vector axes
    merge independently, and conditional undo preserves other authors' changes.
    Entity ids come from persisted disjoint allocations. Comments and replies
    merge by identity. Selection and camera presence remain local presentation,
    with other users' selections drawn as overlays. `deno task test:shared`
    edits one Feel Lab level from two browsers, checks personal undo, concurrent
    creation and replies, pans one camera without moving the other, plays the
    edited level through rollback, flips layouts, and reloads/rejoins. Server
    tests verify saved clocks, source edits and id allocations after restart.
    One shared scene is active per project; disconnected editors must leave or
    rejoin before making further scene edits. See `docs/shared-sessions.md`.

## Shipping

19. **Builds and players.** `ink build` produces a static game (wasm, assets, a
    minimal player without editor code), plus desktop packaging; input devices
    including gamepads and touch; rebindable controls UI. _Done when_ every
    example builds to a playable page under 5 MB plus assets that loads in under
    two seconds.

    **Completed on Linux/WebGPU (2026-10-08).** `ink build` emits a static
    player with no editor modules; `--desktop` packages Electron for the host
    platform. All four examples play from production files under a URL
    subdirectory. Their web payloads are 0.29–0.37 MB plus assets, and measured
    first GPU frames took 265–568 ms on NVIDIA hardware. Gamepad analog input,
    touch controls, short-tap edges and persisted rebinding are verified. The
    packaged Linux Feel Lab renders and jumps without a server. SwiftShader
    startup is slower (2–11 s); Windows/macOS packages have not been exercised.
    See `docs/builds.md` and `deno task test:build` / `test:desktop`.
20. **Multiplayer from pure steps.** Deterministic lockstep and rollback netcode
    come almost free from `step(input, world)`: input exchange, prediction,
    rollback by replaying from keyframes, desync detection by state hash. _Done
    when_ two clients play the Feel Lab together with 100 ms latency and
    rollback hides it.

    **Completed (2026-10-08).** Feel Lab has a two-player scene and room
    controls. The dev relay exchanges canonical per-player inputs; the game
    chooses a runner's owner in Blot. Rollback predicts held controls, restores
    periodic keyframes, replays corrections and checks confirmed packet hashes.
    Lockstep is also available. `deno task test:multiplayer` drives two browser
    contexts with 100 ms one-way input delay: local motion appeared in 51–53 ms,
    both players moved independently, jumping worked, and confirmed packets
    matched byte for byte. Disconnect retains a paused, corrected timeline that
    replays to the same packet. Unit tests cover jitter, reordering, duplicates,
    bounded history, room isolation and desync detection. This is a development
    relay; public matchmaking and authenticated game servers are outside this
    boundary. See `docs/multiplayer.md`.
