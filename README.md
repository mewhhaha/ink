# Ink

One reusable, asset-free game systems source library for [Blot](https://github.com/mewhhaha/blot2), imported as `ink/*`.

Applications own their state layout, main loop, clocks, assets, policies, and GPU resources; Ink provides deterministic simulation, math, physics, rendering descriptors, UI, audio, AI, navigation, netcode, and persistence as plain Blot source modules with zero installer or JS runtime required.

> This is a greenfield project; breaking changes are welcome and superseded APIs are removed. See [AGENTS.md](AGENTS.md) for contributor rules and verification gates.

## Contents

- [Feature Highlights](#feature-highlights)
- [Quick Start](#quick-start)
- [Module Catalog](#module-catalog)
- [Examples](#examples)
- [Core Shaders](#core-shaders)
- [Documentation](#documentation)
- [Develop & Verify](#develop--verify)

## Feature Highlights

- **Incremental ECS & Explicit State** — Typed component pools (`ink/ecs`), cached postfix queries (`ink/ecs/query`), coalesced command batches, dependency-checked recipes, inverse relations, journals, message streams, generational handles, and explicit checkpoints.
- **Zero-Abstraction NaN Safety** — Unboxed `Finite`/`NonZeroFinite`/`UnitF32` scalars, compile-time `NanPolicy` traits (`fast_ieee`, `fallback`, `strict_trap`), scoped `Numeric` effects with zero happy-path dispatch, and `#for #fields` record guards (`ink/numeric`).
- **3D & 2D Deterministic Physics** — Convex/mesh/heightfield colliders, prepared static worlds, warm-started U32-keyed rigid bodies, 6 joint types, ragdolls, vehicles, XPBD cloth/soft bodies, fracture/slicing, triggers, RK4 ballistics, plus a full production 2D physics suite (`ink/physics/d2/`).
- **Declarative & Retained Rendering** — Frame reuse (`ink/render`), dirty-slot matrix caches (`ink/render/cache`), retained instance diffs (`ink/render/retained`), HDR color/GGX lighting/cascaded shadows, baked light & local reflection probes, froxel volumetrics, CDLOD terrain/ocean/foliage, and typed Pen GPU extensions (lines, JFA outlines, GPU particles, 2D GI & SDF UI).
- **Animation & Game Feel** — Clip blending, root motion, 2-bone/FABRIK/CCD IK, foot placement, blend spaces, state machines, spring inertialization, secondary motion, retargeting, motion matching, morph targets, timelines, cinematics, and trauma/hitstop/recoil feel.
- **Drawful Sketch UI & Accessible Headless UI** — Zero-asset immediate-mode hand-drawn UI with 5 fps line boil, marker font, themes, and doodle pad (`ink/ui/sketch`), alongside RTL-aware layout, rich text, accessible headless widgets (`ink/ui/headless/`), a Web Testing Library-style test harness (`ink/ui/testing`), and BCP 47 / CLDR localization (`ink/i18n`).
- **Navigation, AI & Procedural Generation** — Navmesh + funnel smoothing, voxel baking, 8-way A* / Theta*, resumable crowd flow fields, ORCA avoidance, behavior trees, Utility AI, GOAP, perception/EQS, Simplex/Worley/warped noise, Poisson sampling, WFC, and BSP/Delaunay/MST layouts.
- **Gameplay, Spatial Audio & GGPO Netcode** — Gameplay tags, stacked attributes, abilities, inventory/crafting, branching dialogue, quest DAGs, spatial audio + acoustic ray tracing + adaptive music, multi-touch/gesture input, GGPO rollback (`ink/net/rollback`), client prediction, delta replication, and word-native `#for #fields` persistence (`ink/persist/words`).

## Quick Start

```blot
import * as math from "ink/math"

io orbit (angle: F32) : Array F32 => return do:
  let p = math.Quat.rotate (math.axis_angle math.up angle) math.forward
  break #[p.x, p.y, p.z]
```

Clone or vendor this repository and map the `ink` alias to `lib/`. In a standalone Blot project (`blot.json`, using Ink's `blot-workspace.yaml`):

```json
{
  "dependencies": {
    "std": { "path": "../blot2" },
    "ink": { "path": "../ink" }
  },
  "prelude": "std"
}
```

For Pen, merge into `pen.json`:

```json
{
  "compiler": {
    "plugin": "blot",
    "settings": { "imports": { "ink/": "../ink/lib/" } }
  }
}
```

Export a self-contained source bundle (library, shaders, examples, docs, and SHA-256 inventory) with `pen tool ink -- pack dist/ink`.

Applications supply state, assets, font metrics, and policy. Core modules and [examples/ecs.blot](examples/ecs.blot) work without Pen; only the optional `ink/pen/` adapter imports generated `pen/` bindings from `pen codegen`.

Looking for concise, high-performance usage recipes? Start with the **[Idiomatic Patterns & Performance Cookbook](docs/patterns.md)**.

## Module Catalog

### Core Architecture, ECS & Scheduling

| Imports | Capabilities |
| --- | --- |
| `ink/ecs`, `ink/ecs/query`, `ink/ecs/commands`, `ink/ecs/recipe` | Typed component pools, cached postfix membership queries, coalesced column edits, and dependency-checked spawn recipes |
| `ink/app`, `ink/clock`, `ink/time`, `ink/schedule`, `ink/partition` | Composed application stages, explicit fixed-step/timers, access plans, and balanced disjoint work ranges |
| `ink/messages`, `ink/journal`, `ink/relations`, `ink/changes`, `ink/claims` | Independent stream cursors, sparse collection deltas, typed inverse relationship indexes, invalidation batches, and priority claims |
| `ink/handles`, `ink/derived`, `ink/derived/keyed`, `ink/behavior`, `ink/reconcile` | Opaque generational handles, explicit derived/keyed caches, saveable logical-time behaviors, and full-width key reconciliation |
| `ink/task_queue`, `ink/services`, `ink/services/typed`, `ink/kernel_transport`, `ink/kernel_kits`, `ink/preferences` | Cross-frame saved work epochs, bounded typed service queues, ephemeral kernel transport/kits, and typed user preferences |

### Math, NaN Safety & Data Structures

| Imports | Capabilities |
| --- | --- |
| `ink/math`, `ink/numeric`, `ink/transform`, `ink/random`, `ink/noise` | Vectors/quats/rays/matrices, unboxed `Finite`/`NonZeroFinite`/`UnitF32`, compile-time `NanPolicy`, scoped `Numeric` effects, `#for` field NaN guards, affine transforms/pose lerp, explicit PRNG, and 2D/3D fractal noise |
| `ink/map`, `ink/map/frozen`, `ink/set`, `ink/hash`, `ink/arrays`, `ink/sort`, `ink/lookup` | Caller-owned hash maps/sets, dense read-mostly frozen tables, deterministic U32/text hashes, copies, stable sort, and full-width ID lookup |
| `ink/buffer`, `ink/pages`, `ink/graph`, `ink/history`, `ink/statistics` | Explicit chunk builders, paged row storage, compressed adjacency/reachability/dependency waves, bounded ring histories, and counters/stats |
| `ink/field`, `ink/field/sample`, `ink/field/buckets`, `ink/polar`, `ink/radial`, `ink/text`, `ink/logic` | Dirty tile fields, cubic sampling, occupied-tile buckets, polar grids, SIMD soft radial masks, text helpers, and eager Boolean ops |

### 3D & 2D Physics, Spatial Indexing & World Geometry

| Imports | Capabilities |
| --- | --- |
| `ink/physics`, `ink/physics/scene`, `ink/physics/shapes`, `ink/physics/contact`, `ink/physics/rigid`, `ink/physics/character`, `ink/physics/prepared` | Deterministic 3D simulation, convex/mesh/heightfield shapes, seam-free manifolds, rigid bodies, character movement, and prepared static collision scenes |
| `ink/physics/joints`, `ink/physics/ragdoll`, `ink/physics/triggers`, `ink/physics/compound`, `ink/physics/vehicle`, `ink/physics/soft`, `ink/physics/fracture`, `ink/physics/ballistics`, `ink/physics/slice` | 6 joint types with limits/motors, powered ragdolls, Enter/Stay/Exit triggers, compound inertia, raycast vehicles, XPBD cloth/buoyancy, fracture islands, RK4 ballistics/lead solver, and mesh slicing/Voronoi shards |
| `ink/physics/d2/shapes`, `ink/physics/d2/broadphase`, `ink/physics/d2/narrowphase`, `ink/physics/d2/joints`, `ink/physics/d2/queries`, `ink/physics/d2/character`, `ink/physics/d2/world` | Production 2D physics: Circle/Box/Capsule/Polygon/Edge shapes, spatial-hash broadphase, 2-point clipped manifolds with ghost-edge anti-snagging, 6 joints, casts/overlaps, platformer controller, warm-started U32 solver with CCD, sleep, and triggers |
| `ink/spatial`, `ink/spatial/points`, `ink/spatial/point_grid`, `ink/mesh`, `ink/terrain`, `ink/tiles`, `ink/trajectory` | Refittable BVH trees, uniform/paged point grids and exact nearest-point queries, static triangle meshes, heightfields, tile-map collision, and ballistic/authored trajectories |

### Rendering, Cameras, Lighting & Procedural Visuals

| Imports | Capabilities |
| --- | --- |
| `ink/render`, `ink/render/cache`, `ink/render/retained`, `ink/render/bounds`, `ink/render/lod`, `ink/render/streaming` | Declarative frame access, dirty-slot matrix cache, retained instance diffing, batched sphere culling, hysteresis LOD/dither crossfades, and byte-budget cell streaming |
| `ink/render/lighting`, `ink/render/shadow`, `ink/render/probes`, `ink/render/reflections`, `ink/render/volumetrics`, `ink/color`, `ink/environment`, `ink/daylight` | GGX lights/materials, stable shadow cascades, baked SH light probes, box-projected local reflection probes, froxel volumetric fog, HDR tone/grading, sky/SH irradiance, and day cycles |
| `ink/render/terrain`, `ink/render/water`, `ink/render/foliage`, `ink/render/lines`, `ink/render/outlines`, `ink/render/gpu_particles`, `ink/render/d2` | CDLOD terrain quadtree/splat/triplanar, Gerstner ocean waves, wind-bent octahedral foliage, and typed Pen extension encoders (`65005`–`65009`) for 3D/X-ray/2D lines, JFA outlines, GPU particles, SDF UI, and 2D sprites/tilemaps/Radiance Cascades GI |
| `ink/camera`, `ink/view`, `ink/graphics`, `ink/rig`, `ink/director`, `ink/spline`, `ink/particles`, `ink/particles/ribbons`, `ink/debug` | Perspective/ortho cameras, frustum culling, ECS view poses, follow/dolly/collision rigs, interruptible shot blends, constant-speed Catmull-Rom splines, seeded CPU particles/ribbons, and debug geometry |

### Animation, Motion, Cinematics & Game Feel

| Imports | Capabilities |
| --- | --- |
| `ink/animation`, `ink/animation/ik`, `ink/animation/feet`, `ink/animation/blend_space`, `ink/animation/machine` | Skeletal clips, blending, root motion, 2-bone/FABRIK/CCD IK, foot placement, 1D/2D blend spaces, and cross-fading layered state machines |
| `ink/animation/inertialize`, `ink/animation/secondary`, `ink/animation/retarget`, `ink/animation/motion_match`, `ink/animation/morph` | Critically damped spring inertialization, procedural secondary bone chains, skeleton retargeting, motion matching, and sparse morph targets |
| `ink/motion`, `ink/motion/springs`, `ink/tween`, `ink/timeline`, `ink/sequencer`, `ink/feel` | Easing/springs/shake, 4-lane SIMD springs, generic tweens, keyed timelines/cues, multi-track cinematics, trauma shake, hitstop, and recoil |

### UI, Sketch UI, Accessibility & Localization

| Imports | Capabilities |
| --- | --- |
| `ink/ui/sketch` | Asset-free egui-style immediate-mode UI with a Drawful-inspired wobbly hand-drawn look, 5 fps line boil, vector marker font, paper/chalkboard/sticky-note themes, interactive doodle pad, and automatic semantic a11y nodes |
| `ink/ui`, `ink/ui/tree`, `ink/ui/vocabulary`, `ink/ui/layout`, `ink/ui/anchor`, `ink/ui/outline`, `ink/ui/font`, `ink/ui/rich_text`, `ink/ui/dialog`, `ink/ui/console`, `ink/ui/bubbles`, `ink/ui/split_flap`, `ink/ui/touch_controls`, `ink/menu` | Accessibility trees, focus scopes, RTL-aware flex/anchored layout, rounded outlines, font metrics, CJK-aware rich-text wrap, dialogs, dev console with completion, speech bubbles, split-flap displays, virtual touch controls, and menus |
| `ink/ui/headless/controls`, `ink/ui/headless/tabs`, `ink/ui/headless/listbox`, `ink/ui/headless/overlay`, `ink/ui/headless/text_input`, `ink/ui/testing` | Headless accessible widgets (checkbox, switch, radio, spinbutton, progressbar, tabs, accordion, virtualized listbox/select/combobox, menu/popover/tooltip/toasts, rich text input) and Web Testing Library-style semantic queries & a11y auditing |
| `ink/i18n`, `ink/locale` | BCP 47 locale resolution, RTL flags, CLDR plural rules, `{key}` formatting, translation catalogs, and displayed/spoken text caches |

### Navigation, AI & Procedural Generation

| Imports | Capabilities |
| --- | --- |
| `ink/navigation`, `ink/navigation/mesh`, `ink/navigation/corridor`, `ink/navigation/funnel`, `ink/navigation/heap`, `ink/navigation/links`, `ink/navigation/voxel` | Weighted A*, convex navmeshes, polygon A*, funnel smoothing, priority heaps, off-mesh links/dynamic obstacle carving, and 3D voxel heightfield baking |
| `ink/navigation/anyangle`, `ink/navigation/flow`, `ink/navigation/ground`, `ink/navigation/locomotion`, `ink/navigation/lookahead`, `ink/navigation/packet`, `ink/path` | 8-neighbor A*, Theta*, resumable crowd flow fields, ground obstacle routing, locomotion requests, bounded route forecasts, validated nav packets, and checked polylines |
| `ink/ai/bt`, `ink/ai/utility`, `ink/ai/goap`, `ink/ai/perception`, `ink/ai/steering`, `ink/ai/avoidance` | Behavior trees, Utility AI response curves, bitmask GOAP planning, sensory memory & tactical EQS queries, steering/flocking/LOS, and RVO2-style ORCA avoidance |
| `ink/pcg/noise`, `ink/pcg/sampling`, `ink/pcg/wfc`, `ink/pcg/layout`, `ink/placement` | Simplex/Worley/ridged/warped noise, Bridson Poisson disk sampling, 2D WFC solver, BSP dungeons, Delaunay/MST/road extrusion, and seeded placement |

### Gameplay Systems, Audio, Input & Multiplayer Netcode

| Imports | Capabilities |
| --- | --- |
| `ink/gameplay/tags`, `ink/gameplay/attributes`, `ink/gameplay/abilities`, `ink/gameplay/inventory`, `ink/gameplay/dialogue`, `ink/gameplay/quests` | Hierarchical gameplay tags, stacked Add/Multiply/Override attributes, GAS abilities/cooldowns/effects, slot & grid inventory/crafting/loot, branching dialogue graphs, and quest DAGs |
| `ink/audio`, `ink/audio/mix`, `ink/audio/music`, `ink/audio/acoustics`, `ink/sound` | Spatial gain/pan/Doppler/occlusion, virtual voice caps & bus compression, adaptive music clock, acoustic ray tracing, and declarative audio frames |
| `ink/events`, `ink/input`, `ink/input/keys`, `ink/input/gestures`, `ink/tune` | Normalized events, per-frame input state, keycodes, tap/double-tap/hold/chords, stick curves, haptics, and live tune values |
| `ink/net/rollback`, `ink/net/replication`, `ink/net/predict`, `ink/net/interest`, `ink/storefront` | GGPO peer-to-peer rollback, snapshot interpolation/deltas, client prediction & reconciliation, AOI filtering/lag-comp, and achievements/leaderboards/cloud-save conflict resolution |

### Persistence, Editor Tooling, Profiling & Optional Pen Adapter

| Imports | Capabilities |
| --- | --- |
| `ink/persist`, `ink/persist/words`, `ink/codec`, `ink/lanes` | Versioned scene/state saves, exact U32 word-native framing, `#for #fields` derived codecs, and checked F32 lane codecs |
| `ink/editor`, `ink/editor/scene`, `ink/editor/history`, `ink/scene_graph`, `ink/brush`, `ink/gizmos`, `ink/orbit`, `ink/picking`, `ink/profile` | Editable convex brushes, headless 3D scene-graph editor (picking, RGB gizmos, bounded undo/redo history, stash/restore play snapshots), orbit camera, and flame profiler |
| `ink/pen/host`, `ink/pen/program`, `ink/pen/events`, `ink/pen/platform`, `ink/pen/services`, `ink/pen/settings`, `ink/pen/instances`, `ink/pen/retained`, `ink/pen/locale`, `ink/pen/profile`, `ink/pen/semantic`, `ink/pen/simulation` | Optional Blot adapters for Pen's generated wire bindings (`pen/`), retained instances, host services, locale, profiling, semantic observations, and native simulation requests |

## Examples

Runnable standalone Blot programs under `examples/` (no schemas or generated code required):

| Example | Demonstrates |
| --- | --- |
| [examples/orbit.blot](examples/orbit.blot) | Minimal quaternion rotation entry point |
| [examples/ecs.blot](examples/ecs.blot) | Core ECS entity/component pools without Pen |
| [examples/incremental_ecs.blot](examples/incremental_ecs.blot) | Cached queries, recipes, coalesced commands, journals, relations, and message streams |
| [examples/collections.blot](examples/collections.blot) | Caller-owned maps, sets, handles, and explicit copies |
| [examples/physics.blot](examples/physics.blot), [examples/physics_owners.blot](examples/physics_owners.blot) | 3D rigid body simulation and explicit caller-owned physics storage |
| [examples/steps.blot](examples/steps.blot) | Fixed-timestep simulation loop with pose interpolation |
| [examples/joints.blot](examples/joints.blot) | Distance/hinge joint pendulum simulation |
| [examples/ground.blot](examples/ground.blot) | Heightfield terrain queries and ground following |
| [examples/navigation.blot](examples/navigation.blot), [examples/navmesh.blot](examples/navmesh.blot) | Grid A* routing and convex navmesh corridor/funnel smoothing |
| [examples/animation.blot](examples/animation.blot), [examples/cinematic.blot](examples/cinematic.blot) | Skeletal animation blending and multi-track sequencer cinematics |
| [examples/sketch_ui.blot](examples/sketch_ui.blot) | Asset-free Drawful-style immediate-mode UI with live widgets, 5 fps line boil, and doodle pad (interactive Pen WebGPU demo) |
| [examples/d2_lighting.blot](examples/d2_lighting.blot) | 2D tilemaps, sprites, SDF UI, click-to-toss 2D physics, and Radiance Cascades 2D GI (interactive Pen WebGPU demo) |
| [examples/physics_sandbox.blot](examples/physics_sandbox.blot) | 3D wireframe rigid-body crate tower smashed by a swinging distance-joint pendulum with live HUD (interactive Pen WebGPU demo) |
| [examples/nav_playground.blot](examples/nav_playground.blot) | Convex polygon navmesh, A* corridor, funnel string-pulling, and 6 ORCA crowd agents (interactive Pen WebGPU demo) |
| [examples/ik_rig.blot](examples/ik_rig.blot) | Analytic 2-bone IK + 6-segment FABRIK chain tracking a spring-damped cursor target with trauma shake (interactive Pen WebGPU demo) |
| [examples/rollback.blot](examples/rollback.blot) | Deterministic two-peer GGPO rollback with snapshot rings and checksums |
| [examples/showcase_editor.blot](examples/showcase_editor.blot) | Headless 3D scene-graph editor with picking, gizmos, undo/redo, and play snapshots |
| [examples/game.blot](examples/game.blot), [examples/mechanisms.blot](examples/mechanisms.blot) | End-to-end game state composition and cross-module state mechanisms |

## Core Shaders

Five standalone WGSL shaders ship under `shaders/` with [documented bindings and vertex layouts](docs/shaders.md); applications own GPU resources and render pipelines:

| Shader | Purpose |
| --- | --- |
| [shaders/mesh.wgsl](shaders/mesh.wgsl) | Lit PBR/GGX mesh shading with shadows |
| [shaders/sprite.wgsl](shaders/sprite.wgsl) | Screen-space atlas sprites and SDF glyphs |
| [shaders/debug.wgsl](shaders/debug.wgsl) | 3D/2D diagnostic lines and gizmos |
| [shaders/shadow.wgsl](shaders/shadow.wgsl) | Directional shadow cascade depth pass |
| [shaders/display.wgsl](shaders/display.wgsl) | HDR exposure, grading, and display tone curve |

## Documentation

| Guide | Covers |
| --- | --- |
| [docs/patterns.md](docs/patterns.md) | Extensive, concise cookbook of performant & idiomatic Ink/Blot patterns with short examples |
| [docs/blot.md](docs/blot.md) | Full module API contracts, ownership/borrowing rules, and compiler quirks |
| [docs/architecture.md](docs/architecture.md) | Package boundaries, host/library separation, and ABI invariants |
| [docs/state.md](docs/state.md) | Handles, caching, saveable behaviors, and opt-in codec generation |
| [docs/shaders.md](docs/shaders.md) | Core WGSL binding layouts, uniforms, and vertex attributes |
| [docs/testing.md](docs/testing.md) | Blot fixtures, Rust reference oracles, and headless GPU shader tests |
| [docs/benchmarks.md](docs/benchmarks.md) | Benchmark methodology, numerical witnesses, and memory plateau measurements |

## Develop & Verify

Requires a locally built Pen binary, Rust/Cargo, and sibling `../blot2` checkout (`pen.json` wires compiler paths and aliases). Shader tests run headlessly (Mesa's software Vulkan adapter works in CI) and the full suite requires no JS/TS tooling.

```sh
blot test                                  # All Blot test suites + rejected fixtures (via blot.json)
blot test --filter navigation              # Filter Blot test suites by name
pen test-blot                              # All Blot suites + Rust reference & headless GPU tests
pen test-blot --filter navigation          # Filter both Blot and Rust suites
pen test-blot tests/dialogs.blot           # Run one Blot fixture file
blot doc ink --check-links --test          # Verify intra-doc links and run all lib/ doctests
blot doc ink/numeric                       # Print compiler-checked Markdown API for one module
blot doc ink --search Quat                 # Search symbols, signatures, and doc comments
blot doc ink --html --out docs-site        # Export static HTML site with live Wasm examples
pen tool ink -- fmt --check                # Format check
pen tool ink -- generate tools/generate.json
pen tool ink -- bench                      # Full 335-workload benchmark + witnesses
pen tool ink -- bench physics terrain      # Subset benchmark
pen tool ink -- pack dist/ink              # Export standalone source package
pen tool ink -- site dist/site --overwrite # Build GitHub Pages examples gallery (Pen WebGPU + Wasm + docs)
```

Benchmarks retain numerical witnesses and record compilation, execution, spread, source hashes, deterministic replay, and memory plateaus in `.cache/bench-library-native.json`.
