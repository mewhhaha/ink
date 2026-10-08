# Twenty hills

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

Smaller things noticed while building, to clear before or alongside the hills:

- **Renderer gaps.** Noisy PCSS penumbrae up close (wants TAA, hill 8); no
  reflection probes or SSR, so surfaces reflect only the sky; no clouds; the sky
  is seen from a fixed altitude; fog in-scattering ignores shadows; only the
  first shadowing directional light casts; shadow maps are not culled per
  cascade.
- **Brush tools.** Resize and clip handle only translation-only, top-level
  brushes; clip only in 2D views; no marquee select, vertex/edge editing or
  per-tool hover cursors (`ViewportTool.cursor` is static).
- **Hammer example.** Trigger volumes are boxes, not brushes; the full button
  chain was proven headlessly, not walked through in the browser.
- **Dev CLI.** `capture` once printed "Ink hooks need an <InkApp>" from the
  Hammer app; `@ink/dev` does not export its catalog/node helpers, so the
  TrenchBroom tests import them by relative path.
- **Blot2 compiler quirks** (see docs/blot.md): `from` inside a nested array
  literal with a spread fails with `constant_expression`; a field cannot be
  projected from a qualified module value (`s.defaults.x`). Worth reporting
  upstream to blot2.
- **Verification.** Everything visual was checked in headless Chromium with
  SwiftShader and on an RTX 4080 through Deno's WebGPU — never in a real browser
  on a real GPU. Do that first when available. The 2026-10-08 follow-up
  confirmed an RTX 4080 SUPER through Deno, but headed Chromium with hardware
  Vulkan reported no WebGPU adapter. `deno task test:render --hardware --headed`
  provides a repeatable check and rejects a software fallback.

## Runtime

1. **Keep the world in the guest.** Today every step copies, decodes and
   re-encodes the whole world (~0.4 ms per 1,000 entities). Keep state in Wasm
   memory across steps (a suspended `for ever` loop or stateful entries),
   transfer only changed entities, decode on the host lazily. _Done when_ 20,000
   entities step at 60 Hz with snapshots, rewind and hot reload unchanged, and
   headless runs give byte-identical states.
2. **Physics as a Blot library.** Capsules, boxes and convex hulls; swept
   collision; a character controller with slopes, steps and moving platforms;
   rigid bodies with stable stacking; queries (ray, shape cast, overlap).
   Deterministic, so replays and hand-offs reproduce. _Done when_ the examples
   drop their ad-hoc collision and a test stacks 50 boxes for 10 s with
   identical results across runs.
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

## Rendering

5. **Clustered lighting.** Light culling into view-space clusters so hundreds of
   point and spot lights cost what eight do now; light-type icons and ranges in
   editors. _Done when_ 512 lights render at 60 fps on a mid GPU.
6. **Transparency and particles.** Sorted alpha blending, alpha-tested foliage,
   additive effects, and a GPU particle system (compute) whose emitters are
   components and whose bursts are Blot events. _Done when_ fire, smoke and
   sparks run in the Godot example and survive rewind (particles are
   presentation, reseeded from the tick).
7. **Animated meshes.** Full glTF: node hierarchy, materials, skins and
   animation clips; blending and state machines driven by component values;
   attachment points. _Done when_ a skinned character walks and jumps in the
   Feel Lab with poses following game state and scrubbing the timeline.
8. **Temporal anti-aliasing and upscaling.** Motion vectors, TAA with history
   rejection, render-scale upscaling; lets AO, shadows and grain accumulate over
   frames. _Done when_ edges are stable while moving and half-resolution
   rendering looks close to native.
9. **Global illumination.** Baked lightmaps for brush levels (path-traced on the
   GPU, rebaked in the background after edits), reflection probes, and
   screen-space reflections. _Done when_ the Hammer level's dark room is lit by
   bounce light from the lamp and rebakes within seconds of a brush edit.
10. **Large worlds.** Heightmap terrain with noise-based detail and splat
    materials, LOD for meshes and terrain, frustum and occlusion culling, asset
    streaming. _Done when_ a 4 km² terrain with 100,000 instances edits and
    plays smoothly.
11. **2D.** Sprites, atlases, tilemaps, 2D lights and SDF text on the same
    session and tools; an orthographic tile editor example. _Done when_ a tile
    platformer is built in an example editor in an afternoon with the same hot
    reload and hand-offs.

## Iteration

12. **Sub-100 ms everything.** Blot incremental builds under 100 ms on large
    games (with blot2's hills), patching a running guest instead of
    re-instantiating, asset imports in workers, and a frame profiler (guest
    step, decode, extraction, GPU timestamps) always visible. _Done when_ a
    save-to-pixels loop is measured and shown in the editor, and stays under 150
    ms for code and under 50 ms for tuning values.
13. **Asset pipeline.** Import on save: KTX2/Basis texture compression, mipmaps,
    mesh optimisation and LODs, audio transcoding; a content-addressed cache;
    thumbnails for meshes and materials in the asset browser. _Done when_
    dropping a 50 MB glTF into `assets/` is usable in the editor in seconds and
    loads fast in a build.
14. **Editing depth.** Box selection, snapping to surfaces and vertices,
    vertex/edge/face brush editing, brush CSG (subtract, merge), texture lock,
    alignment tools, a visible history panel, rebindable shortcuts. _Done when_
    a TrenchBroom user rebuilds a Quake-sized room without leaving the
    keyboard-and-mouse habits they have.
15. **Scenario tests.** Recorded inputs plus assertions on world state and
    golden images, as files beside the game, run headlessly in CI with a GPU (or
    SwiftShader) and shown in the editor's timeline when they fail. _Done when_
    every example ships scenarios and a broken jump shows the failing tick and
    image diff.

## Agents and collaboration

16. **The editor as a live agent surface.** An MCP server (and HTTP API) over
    the running session: read the world, apply edits, play, step, capture any
    view, reply to and resolve comments, open hand-offs. Agents see exactly what
    the person sees and changes appear live in their editor. _Done when_ an
    agent fixes a comment end to end — reads it, reproduces it from the replay,
    edits code, captures before/after, resolves it — without the person leaving
    the editor.
17. **Comments as a workflow.** Threads, assignees, statuses, before/after
    captures attached to replies, comments on timeline ranges and on code lines
    from diagnostics, and a queue an agent can work through. _Done when_ a
    play-test session produces a list of comments an agent burns down overnight
    with captures as proof.
18. **Multi-user sessions.** Several people (and agents) in one live session: a
    CRDT scene document, presence, per-user selection and cameras, shared
    comments. _Done when_ two browsers edit one level and play it together.

## Shipping

19. **Builds and players.** `ink build` produces a static game (wasm, assets, a
    minimal player without editor code), plus desktop packaging; input devices
    including gamepads and touch; rebindable controls UI. _Done when_ every
    example builds to a playable page under 5 MB plus assets that loads in under
    two seconds.
20. **Multiplayer from pure steps.** Deterministic lockstep and rollback netcode
    come almost free from `step(input, world)`: input exchange, prediction,
    rollback by replaying from keyframes, desync detection by state hash. _Done
    when_ two clients play the Feel Lab together with 100 ms latency and
    rollback hides it.
