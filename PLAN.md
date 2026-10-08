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

The requested scope includes these fixes and all twenty hills below. A hill is
complete only when its stated gate has been verified.

- **Renderer follow-up implemented.** Procedural layered clouds with a
  deterministic offset, observer altitude, shadowed sun scattering in fog, up to
  four shadowing directional lights, and per-cascade caster culling. Noisy PCSS
  now accumulates with temporal anti-aliasing (hill 8); scene reflections still
  need probes/SSR (hill 9). Clouds are a layer, not a volumetric simulation.
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
