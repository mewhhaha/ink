# Ink

Reusable game systems for [Blot](https://github.com/mewhhaha/blot2). One source
library, imported as `ink/*`.

This is a greenfield project; breaking changes are welcome and superseded APIs
are removed. See [agent instructions](AGENTS.md) for contributor conventions
and verification gates.

```blot
import * as math from "ink/math"

#entry func orbit (angle: F32) : Array F32 => return do:
  let p = math.Quat.rotate (math.axis_angle math.up angle) math.forward
  break #[p.x, p.y, p.z]
```

## Use it

Clone or vendor this repository and map the compiler's `ink/` alias to `lib/`.
For Pen, merge these settings into your project's `pen.json`:

```json
{
  "compiler": {
    "plugin": "blot",
    "settings": { "imports": { "ink/": "../ink/lib/" } }
  }
}
```

`pen tool ink -- pack dist/ink` exports a source-only directory containing the
library, shaders, examples, documentation and a SHA-256 inventory. Point the
same alias at its `lib/` directory. The exported library needs no installer or
JavaScript runtime.

## Modules

`ink/editor/history` provides bounded encoded-scene history, explicit checkpoint
copies, undo/redo travel and stash/restore over caller-owned pools.

| Import                                                                                                          | Provides                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ink/profile`, `ink/pen/profile`                                                                                | Caller-owned profile aggregation, flame layout and validated Pen packet decoding                             |
| `ink/reconcile`                                                                                                 | Match unique full-width keys while preserving caller-owned values                                            |
| `ink/field/sample`                                                                                              | Cubic field sampling with explicit coordinates and border handling                                           |
| `ink/field/buckets`                                                                                             | Stable footprint indices per tile, including only occupied tiles                                             |
| `ink/trajectory`                                                                                                | Ballistic trajectories, authored arches and ordered chord traversal                                          |
| `ink/motion/springs`                                                                                            | Prepared scalar springs and four-lane steps over retained numeric columns                                    |
| `ink/render/bounds`                                                                                             | Batched sphere culling and projected diameters over caller-owned columns                                     |
| `ink/render/lod`, `ink/render/streaming`                                                                        | Projected extents, hysteresis LOD selection, dither crossfades and byte-budget world-cell streaming          |
| `ink/render/terrain`, `ink/render/water`, `ink/render/foliage`                                                  | CDLOD terrain quadtree/morph/splat/triplanar, Gerstner ocean waves/absorption and wind-bent octahedral foliage |
| `ink/render/lines`, `ink/render/outlines`, `ink/render/gpu_particles`, `ink/render/d2`                          | Typed Pen extension encoders (`65005`–`65009`) for antialiased 3D/X-ray/2D lines, JFA outlines, GPU mesh particles, SDF UI and 2D tilemaps/sprites/Radiance Cascades GI |
| `ink/changes`, `ink/pages`                                                                                      | Explicit invalidation batches and caller-owned paged storage                                                 |
| `ink/map`, `ink/set`, `ink/hash`                                                                                | Caller-owned hash maps and sets, explicit key policies, deterministic U32/text hashes                        |
| `ink/map/frozen`                                                                                                | Dense read-mostly hash tables with explicit key policies and stable insertion order                          |
| `ink/buffer`                                                                                                    | Caller-owned chunk builders with explicit publication                                                        |
| `ink/graph`                                                                                                     | Compressed adjacency, bounded reachability queues and deterministic dependency waves                         |
| `ink/math`, `ink/numeric`                                                                                       | Vectors, quaternions, colors, rays, rotations, unboxed `Finite`/`UnitF32` scalars, compile-time `NanPolicy` traits, scoped `Numeric` effects and `#for` field NaN guards |
| `ink/arrays`, `ink/sort`, `ink/lookup`                                                                          | Array copies, stable sorting and full-width ID lookup                                                        |
| `ink/time`, `ink/transform`                                                                                     | Explicit timers, fixed steps, affine transforms and pose interpolation                                       |
| `ink/random`, `ink/noise`                                                                                       | Explicit random state, seeded Perlin/value noise (2D and 3D) and fractal sums                                |
| `ink/terrain`                                                                                                   | Heightfield sampling, normals, slopes, ground following and bounds                                           |
| `ink/tiles`                                                                                                     | Tile flags, queries and box movement through tile maps                                                       |
| `ink/physics/shapes`, `ink/physics/contact`, `ink/mesh`                                                                         | Convex shapes, static triangle meshes with seam-free edge handling, casts and contact manifolds                         |
| `ink/physics/scene`                                                                                                     | Physics data types, scene construction and spatial queries                                                   |
| `ink/spatial`, `ink/spatial/points`, `ink/spatial/point_grid`                                                   | Bounding-volume trees with explicit refitting, uniform/paged point grids and exact nearest point queries     |
| `ink/physics/rigid`, `ink/physics/character`, `ink/physics`                                                                     | Rigid bodies, character movement and deterministic simulation                                                |
| `ink/physics/triggers`, `ink/physics/compound`, `ink/physics/vehicle`, `ink/physics/soft`, `ink/physics/fracture` | Trigger Enter/Stay/Exit lifecycle, compound inertia, raycast vehicles, XPBD cloth/buoyancy and fracture islands |
| `ink/camera`, `ink/render/shadow`                                                                                      | Perspective/orthographic cameras, picking, frustum culling, stable shadow cascades                           |
| `ink/spline`, `ink/rig`                                                                                         | Constant-speed centripetal Catmull-Rom paths; follow, framing, collision and dolly camera rigs               |
| `ink/color`, `ink/render/lighting`, `ink/environment`                                                                  | HDR transfer/exposure/tone curves, GGX lights/materials, sky and SH irradiance                               |
| `ink/render/probes`                                                                                                    | Baked diffuse light probes: SH irradiance lattice, bounce bake, interpolation                                |
| `ink/render/reflections`                                                                                               | Local reflection probes: influence weights, priority blending, box projection, slot choice                   |
| `ink/render/volumetrics`                                                                                               | Froxel volumetric fog: tiers, depth slicing, mist and local volumes, phase, column integration, history      |
| `ink/particles`, `ink/particles/ribbons`, `ink/motion`, `ink/animation`                                         | Seeded particles, camera-facing ribbon trails, atlas sprites, easing/springs/shake, clips/blending/root motion |
| `ink/animation/ik`, `ink/animation/feet`, `ink/animation/blend_space`, `ink/animation/machine` | Two-bone/FABRIK/CCD IK, aim chains, foot placement, blend spaces, cross-fading state machines and layers |
| `ink/animation/inertialize`, `ink/animation/secondary`, `ink/animation/retarget`, `ink/animation/motion_match`, `ink/animation/morph` | Critically damped spring inertialization, procedural secondary bone chains, skeleton retargeting, motion matching and sparse morph targets |
| `ink/tween`, `ink/timeline`, `ink/sequencer`                                                                      | Data easings, generic tweens and slerp, keyed tracks, cues, loop/ping-pong playback and multi-track cinematics |
| `ink/audio`, `ink/audio/mix`, `ink/audio/music`, `ink/audio/acoustics`                                          | Spatial gain/pan/Doppler/occlusion, virtual voice caps, bus compression, adaptive music clock and acoustic ray tracing |
| `ink/navigation`, `ink/ai/steering`                                                                                | Weighted A*, flow fields, crowd steering, flocking, obstacle avoidance, field-of-view/line-of-sight          |
| `ink/physics/joints`, `ink/physics/ragdoll`, `ink/placement`, `ink/debug` | Distance/spring/hinge/ball cone-twist/slider/fixed constraints with limits and motors, skeleton ragdolls with powered poses and read-back blending, seeded placement, drawable diagnostic geometry |
| `ink/ecs`, `ink/app`, `ink/clock`                                                                               | Typed resource/component pools, explicit checkpoints, schedules and caller-selected fixed steps              |
| `ink/ecs/query`, `ink/ecs/commands`, `ink/ecs/recipe`                                                           | Composable membership queries, explicit edit commits and dependency-checked spawn recipes                    |
| `ink/messages`, `ink/journal`, `ink/relations`                                                                  | Independent stream readers, sparse collection changes and typed inverse relationship indexes                 |
| `ink/task_queue`, `ink/services/typed`                                                                          | Saved cross-frame work, lifetime epochs, ordered delivery and typed service responses                        |
| `ink/schedule`, `ink/partition`                                                                                 | Explicit access plans and balanced disjoint ranges; callers own execution                                    |
| `ink/claims`                                                                                                    | Bounded resource proposals with deterministic priority and owner ties                                        |
| `ink/net/rollback`, `ink/net/replication`, `ink/net/predict`, `ink/net/interest`                                        | GGPO rollback, snapshot interpolation/deltas, client prediction reconciliation, AOI filtering and lag-comp   |
| `ink/handles`, `ink/derived`, `ink/behavior`, `ink/codec`                                                       | Stable typed objects, explicit derived resources, saveable logical-time behaviors and derived codec adapters |
| `ink/lanes`, `ink/persist`                                                                                      | Checked numeric codecs, exact U32 halves, versioned state and scene sections                                 |
| `ink/events`, `ink/input`, `ink/input/keys`, `ink/input/gestures`, `ink/tune`                                   | Normalized events, per-frame input, tap/double-tap/hold/chords, stick curves, haptics and live tune values   |
| `ink/ui`, `ink/ui/tree`, `ink/ui/dialog`, `ink/ui/font`, `ink/ui/vocabulary`, `ink/ui/layout`, `ink/ui/rich_text`, `ink/menu` | Headless controls, text editing, RTL-aware flex layout & menus, virtual scroll, CJK-aware rich-text wrap, focus and a11y nodes |
| `ink/ui/headless/controls`, `ink/ui/headless/tabs`, `ink/ui/headless/listbox`, `ink/ui/headless/overlay`, `ink/ui/headless/text_input` | Pure headless accessible widgets: tri-state checkbox, switch, radio group, spinbutton, progressbar, tabs, accordion, listbox/select/combobox with typeahead & virtualization, menu/popover/tooltip/toasts and rich text input |
| `ink/ui/testing`                                                                                                | Web Testing Library-style semantic role queries, modal-aware user-event simulation and pure-Blot accessibility tree auditing |
| `ink/ui/sketch`                                                                                                 | Asset-free egui-style immediate-mode UI with a Drawful-inspired wobbly hand-drawn aesthetic, 5 fps line boil, vector marker font, paper/chalkboard/sticky-note themes, doodle pad and automatic semantic a11y nodes |
| `ink/ui/split_flap`                                                                                             | Mechanical letter flips with clipped caller glyphs and a caller-controlled phase                             |
| `ink/preferences`, `ink/services`, `ink/kernel_transport`, `ink/kernel_kits`, `ink/text`, `ink/logic`           | Preference values, bounded request queues, ephemeral kernel transport & kits, text helpers and eager Boolean ops |
| `ink/render`, `ink/view`, `ink/sound`, `ink/graphics`                                                           | Declarative draw/audio values, ECS camera poses, sky and cascaded shadow preparation                         |
| `ink/field`, `ink/history`, `ink/statistics`                                                                    | Dirty sample regions, tile revisions, bounded histories and counter/sample statistics                        |
| `ink/ui/anchor`, `ink/ui/outline`, `ink/ui/console`                                                             | Anchored layout, rounded outlines, catalog completion and command-history navigation                         |
| `ink/i18n`, `ink/locale`, `ink/pen/locale`                                                                      | First-class BCP 47 / RTL / CLDR plurals / `{key}` formatting / catalogs, displayed/spoken caches and Pen locale requests |
| `ink/derived/keyed`                                                                                             | Discardable caches with complete dependency keys and explicit revision tokens                                |
| `ink/navigation/locomotion`                                                                                     | Ground motion requests independent of occupations, inventory and animation policy                            |
| `ink/navigation/lookahead`, `ink/navigation/packet`                                                             | Bounded pure route forecasts and validated numeric geometry transport                                        |
| `ink/navigation/mesh`, `ink/navigation/corridor`, `ink/navigation/funnel`, `ink/navigation/heap`                | Convex navigation meshes (authored or grid-derived), polygon A*, funnel smoothing, straight walks            |
| `ink/navigation/anyangle`, `ink/navigation/flow`, `ink/ai/avoidance`                                                  | Eight-neighbour A*, Theta*, resumable flow fields and RVO2-style ORCA local avoidance                        |
| `ink/navigation/links`, `ink/navigation/voxel`                                                                     | Off-mesh navigation links, dynamic obstacle carving and 3D triangle voxel heightfield baking                 |
| `ink/ai/bt`, `ink/ai/utility`, `ink/ai/goap`, `ink/ai/perception`                                                  | Behavior trees, Utility AI response curves, bitmask GOAP planning, sensory memory and tactical EQS queries   |
| `ink/gameplay/tags`, `ink/gameplay/attributes`                                                                     | Hierarchical gameplay tag containers and stacked Add/Multiply/Override attribute modifiers with cooldowns    |
| `ink/gameplay/dialogue`, `ink/gameplay/abilities`, `ink/gameplay/inventory`, `ink/gameplay/quests`                 | Branching narrative/dialogue graphs, GAS abilities & timed status effects, slot/grid inventory/crafting/loot, quest DAGs |
| `ink/pcg/noise`, `ink/pcg/sampling`, `ink/pcg/wfc`, `ink/pcg/layout`                                               | Simplex/Worley/ridged/warped noise, Bridson Poisson disk, 2D WFC solver, BSP dungeons, Delaunay/MST and road extrusion |
| `ink/feel`, `ink/physics/ballistics`, `ink/physics/slice`                                                          | Trauma shake, hitstop, recoil/spring-arm/dolly, RK4 ballistics & lead solver, mesh slicing & Voronoi shards |
| `ink/physics/d2/shapes`, `ink/physics/d2/broadphase`, `ink/physics/d2/narrowphase`, `ink/physics/d2/joints`, `ink/physics/d2/queries`, `ink/physics/d2/character`, `ink/physics/d2/world` | Production 2D physics: Circle/Box/Capsule/Polygon/Edge shapes with filters, O(N) spatial-hash broadphase, 2-point clipped manifolds with ghost-edge anti-snagging, 6 joint types, ray/shape/overlap queries, 2D platformer character controller, warm-started U32-keyed solver with CCD, sleep and Enter/Stay/Exit triggers |
| `ink/ui/touch_controls`, `ink/storefront`                                                                          | Multi-touch virtual thumbsticks/buttons, monotonic achievement/stat sync, leaderboards and cloud-save conflict resolution |
| `ink/pen/semantic`                                                                                              | Optional bounded semantic observation encoding, exact identities, descriptors and decision events            |
| `ink/pen/simulation`                                                                                            | Optional Pen adapter for collider, physics, navigation and noise service requests                            |
| `ink/director`                                                                                                  | Camera shot blends that survive interruption, even focal-length zooms and shake                              |
| `ink/brush`, `ink/editor`, `ink/editor/scene`, `ink/gizmos`, `ink/orbit`, `ink/picking`, `ink/scene_graph` | Editable convex geometry, configurable tools, headless 3D scene-graph editor (picking, RGB gizmos, undo/redo, play snapshots), camera movement, selection and hierarchical scene/prefab graphs |
| `ink/daylight`, `ink/path`, `ink/navigation/ground`                                                             | Configurable day cycles, checked polylines and ground obstacle routing                                       |
| `ink/polar`                                                                                                     | Configurable polar grids, plot centres and nearby-ring queries                                               |
| `ink/radial`                                                                                                    | Overlapping soft circular masks over caller-owned grids, with SIMD stamp batches                             |
| `ink/ui/bubbles`                                                                                                | Camera-facing planes and live cubic control points for caller-owned bubble geometry                          |
| `ink/pen/events`, `ink/pen/host`, `ink/pen/platform`, `ink/pen/program`, `ink/pen/services`, `ink/pen/settings` | Optional Blot adapter for Pen's generated wire bindings                                                      |
| `ink/render/cache`                                                                                              | Caller-owned draw matrices refreshed by explicit dirty entity slots                                          |
| `ink/physics/prepared`                                                                                          | Prepared static collision geometry for small moving work sets                                                |
| `ink/persist/words`                                                                                             | Word-native state and scene saves through a U32 host boundary                                                |
| `ink/pen/instances`, `ink/pen/retained`, `ink/render/retained`                                                  | Optional retained rendering with caller-owned identities, explicit updates and matching Pen bindings         |

See [the API and compiler notes](docs/blot.md) and
[the package boundary](docs/architecture.md). [Examples](examples/orbit.blot)
construct library values directly. [Application state mechanisms](docs/state.md)
document handles, caching, behavior saves and opt-in codec generation.

Applications supply state, assets, font metrics and policy. The optional
`ink/pen/host` adapter additionally needs a `pen/` alias pointing at bindings
from `pen codegen`. Core imports and the [ECS example](examples/ecs.blot) work
without Pen. Pen's renderer and native services remain independent of Ink.

## Core shaders

Five standalone WGSL sources cover a lit mesh, atlas sprites, debug lines,
shadow depth and HDR display conversion. They ship under `shaders/` with
[documented bindings and vertex layouts](docs/shaders.md). Applications own the
renderer and GPU resources.

## Develop

Use a full Pen build, Rust/Cargo, and a built sibling `../blot2` checkout.
`pen.json` names the compiler executable, standard library and import aliases.
Build/install Pen from `../pen` after updating its compiler plugin. The native
reference suite uses Pen's sibling Rust crates. Shader tests need a GPU adapter;
Mesa's software Vulkan adapter works in CI.

```sh
pen test-blot
pen test-blot --filter navigation
pen test-blot tests/dialogs.blot
pen tool ink -- fmt --check
pen tool ink -- generate tools/generate.json
pen tool ink -- bench
pen tool ink -- bench physics terrain
pen tool ink -- pack dist/ink
```

`pen test-blot` runs Blot reports, expected traps and compile rejections,
followed by the Rust references in `tools/native`. The Rust suite includes
numerical oracles, stress and memory checks, generator checks, isolated source
consumers, executable documentation examples and real offscreen WGSL rendering.
The full suite requires no JavaScript/TypeScript tooling. `--filter` applies to
both suites; explicit `.blot` files select only those Blot modules. `--jobs`
limits test concurrency. Compiler sessions and compiled modules are reused,
while each test starts with a fresh guest instance.

New report-style fixtures belong in `pen.json`'s compiler test list. Independent
host references belong in `tools/native/src`. See [testing](docs/testing.md),
[architecture](docs/architecture.md) and [API contracts](docs/blot.md).

Benchmarks retain numerical witnesses and report compilation, execution, spread,
source hashes, deterministic replay and memory plateaus in
`.cache/bench-library-native.json`. See
[measurements and limits](docs/benchmarks.md).
