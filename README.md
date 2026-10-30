# Ink

Reusable game systems for [Blot](https://github.com/mewhhaha/blot2). One source
library, imported as `ink/*`.

This is a greenfield project; breaking changes are welcome and superseded APIs
are removed. The owned-storage rewrite is unfinished. Start with
[continuation notes](https://github.com/mewhhaha/ink/blob/main/CONTINUE.md) and
[agent instructions](https://github.com/mewhhaha/ink/blob/main/AGENTS.md); the
next milestone is one real Gdev frame through Pen. Examples and earlier
measurements do not establish current integration readiness.

```blot
import * as math from "ink/math"

entry const orbit = func (angle: F32) : Array F32 => return do:
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

| Import                                                                                                          | Provides                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ink/profile`, `ink/pen/profile`                                                                                | Caller-owned profile aggregation, flame layout and validated Pen packet decoding                             |
| `ink/reconcile`                                                                                                 | Match unique full-width keys while preserving caller-owned values                                            |
| `ink/field/sample`                                                                                              | Cubic field sampling with explicit coordinates and border handling                                           |
| `ink/field/buckets`                                                                                             | Stable footprint indices per tile, including only occupied tiles                                             |
| `ink/pen/worker_session`                                                                                        | Prepared native worker service and client batches with explicit immutable context                            |
| `ink/trajectory`                                                                                                | Ballistic trajectories, authored arches and ordered chord traversal                                          |
| `ink/motion/springs`                                                                                            | Prepared scalar springs and four-lane steps over retained numeric columns                                    |
| `ink/render/bounds`                                                                                             | Batched sphere culling and projected diameters over caller-owned columns                                     |
| `ink/render/lod`                                                                                                | Projected extents and caller-owned level selection with hysteresis                                           |
| `ink/changes`, `ink/pages`                                                                                      | Explicit invalidation batches and caller-owned paged storage                                                 |
| `ink/map`, `ink/set`, `ink/hash`                                                                                | Caller-owned hash maps and sets, explicit key policies, deterministic U32/text hashes                        |
| `ink/map/frozen`                                                                                                | Dense read-mostly hash tables with explicit key policies and stable insertion order                          |
| `ink/buffer`                                                                                                    | Caller-owned chunk builders with explicit publication                                                        |
| `ink/graph`                                                                                                     | Compressed adjacency, bounded reachability queues and deterministic dependency waves                         |
| `ink/math`                                                                                                      | Vectors, quaternions, colors, rays and rotations                                                             |
| `ink/arrays`, `ink/sort`, `ink/lookup`                                                                          | Array copies, stable sorting and full-width ID lookup                                                        |
| `ink/time`, `ink/transform`                                                                                     | Explicit timers, fixed steps, affine transforms and pose interpolation                                       |
| `ink/random`, `ink/noise`                                                                                       | Explicit random state, seeded Perlin/value noise and fractal sums                                            |
| `ink/terrain`                                                                                                   | Heightfield sampling, normals, slopes, ground following and bounds                                           |
| `ink/tiles`                                                                                                     | Tile flags, queries and box movement through tile maps                                                       |
| `ink/shapes`, `ink/contact`                                                                                     | Convex shapes, casts and contact manifolds                                                                   |
| `ink/scene`                                                                                                     | Physics data types, scene construction and spatial queries                                                   |
| `ink/spatial`, `ink/spatial/points`, `ink/spatial/point_grid`                                                   | Bounding-volume trees with explicit refitting, uniform/paged point grids and exact nearest point queries     |
| `ink/rigid`, `ink/character`, `ink/physics`                                                                     | Rigid bodies, character movement and deterministic simulation                                                |
| `ink/camera`, `ink/shadow`                                                                                      | Perspective/orthographic cameras, picking, frustum culling, stable shadow cascades                           |
| `ink/spline`, `ink/rig`                                                                                         | Constant-speed centripetal Catmull-Rom paths; follow, framing, collision and dolly camera rigs               |
| `ink/color`, `ink/lighting`, `ink/environment`                                                                  | HDR transfer/exposure/tone curves, GGX lights/materials, sky and SH irradiance                               |
| `ink/particles`, `ink/motion`, `ink/animation`                                                                  | Seeded particles, atlas sprites/billboards, easing/springs/shake, clips/blending/root motion/events          |
| `ink/tween`, `ink/timeline`                                                                                     | Data easings, generic tweens and slerp, keyed tracks, cues and loop/ping-pong playback                       |
| `ink/audio`                                                                                                     | Spatial gain, panning, Doppler, fades and scene occlusion                                                    |
| `ink/navigation`, `ink/steering`                                                                                | Weighted A*, flow fields, crowd steering, flocking, obstacle avoidance, field-of-view/line-of-sight          |
| `ink/joints`, `ink/placement`, `ink/debug`                                                                      | Distance/spring/hinge/motor constraints, seeded placement, drawable diagnostic geometry                      |
| `ink/ecs`, `ink/app`, `ink/clock`                                                                               | Typed resource/component pools, explicit checkpoints, schedules and caller-selected fixed steps              |
| `ink/ecs/query`, `ink/ecs/commands`, `ink/ecs/recipe`                                                           | Composable membership queries, explicit edit commits and dependency-checked spawn recipes                    |
| `ink/messages`, `ink/journal`, `ink/relations`                                                                  | Independent stream readers, sparse collection changes and typed inverse relationship indexes                 |
| `ink/task_queue`, `ink/services/typed`                                                                          | Saved cross-frame work, lifetime epochs, ordered delivery and typed service responses                        |
| `ink/schedule`, `ink/partition`                                                                                 | Explicit access plans and balanced disjoint ranges; callers own execution                                    |
| `ink/claims`                                                                                                    | Bounded resource proposals with deterministic priority and owner ties                                        |
| `ink/handles`, `ink/derived`, `ink/behavior`, `ink/codec`                                                       | Stable typed objects, explicit derived resources, saveable logical-time behaviors and derived codec adapters |
| `ink/lanes`, `ink/persist`                                                                                      | Checked numeric codecs, exact U32 halves, versioned state and scene sections                                 |
| `ink/events`, `ink/input`, `ink/input/keys`, `ink/tune`                                                         | Normalized events, per-frame input and validated live values                                                 |
| `ink/ui`, `ink/ui/tree`, `ink/ui/dialog`, `ink/ui/font`, `ink/ui/vocabulary`, `ink/menu`                        | Headless controls, text editing, caller fonts, layout, focus and accessible nodes                            |
| `ink/ui/split_flap`                                                                                             | Mechanical letter flips with clipped caller glyphs and a caller-controlled phase                             |
| `ink/preferences`, `ink/services`, `ink/text`, `ink/logic`                                                      | Preference values, bounded request queues, text helpers and eager Boolean operations                         |
| `ink/render`, `ink/view`, `ink/sound`, `ink/graphics`                                                           | Declarative draw/audio values, ECS camera poses, sky and snapped shadow preparation                          |
| `ink/field`, `ink/history`, `ink/statistics`                                                                    | Dirty sample regions, tile revisions, bounded histories and counter/sample statistics                        |
| `ink/ui/anchor`, `ink/ui/outline`, `ink/ui/console`                                                             | Anchored layout, rounded outlines, catalog completion and command-history navigation                         |
| `ink/locale`, `ink/pen/locale`                                                                                  | Caller-owned displayed/spoken text caches and optional Pen locale requests                                   |
| `ink/derived/keyed`                                                                                             | Discardable caches with complete dependency keys and explicit revision tokens                                |
| `ink/navigation/locomotion`                                                                                     | Ground motion requests independent of occupations, inventory and animation policy                            |
| `ink/navigation/lookahead`, `ink/navigation/packet`                                                             | Bounded pure route forecasts and validated numeric geometry transport                                        |
| `ink/pen/semantic`                                                                                              | Optional bounded semantic observation encoding, exact identities, descriptors and decision events            |
| `ink/pen/simulation`                                                                                            | Optional Pen adapter for collider, physics, navigation and noise service requests                            |
| `ink/director`                                                                                                  | Camera shot blends that survive interruption, even focal-length zooms and shake                              |
| `ink/brush`, `ink/editor`, `ink/gizmos`, `ink/orbit`, `ink/picking`                                             | Editable convex geometry, configurable tools, camera movement and selection                                  |
| `ink/daylight`, `ink/path`, `ink/navigation/ground`                                                             | Configurable day cycles, checked polylines and ground obstacle routing                                       |
| `ink/polar`                                                                                                     | Configurable polar grids, plot centres and nearby-ring queries                                               |
| `ink/ui/bubbles`                                                                                                | Camera-facing planes and live cubic control points for caller-owned bubble geometry                          |
| `ink/pen/events`, `ink/pen/host`, `ink/pen/platform`, `ink/pen/program`, `ink/pen/services`, `ink/pen/settings` | Optional Blot adapter for Pen's generated wire bindings                                                      |
| `ink/render/cache`                                                                                              | Caller-owned draw matrices refreshed by explicit dirty entity slots                                          |
| `ink/physics/prepared`                                                                                          | Prepared static collision geometry for small moving work sets                                                |
| `ink/persist/words`                                                                                             | Word-native state and scene saves through a U32 host boundary                                                |
| `ink/pen/instances`, `ink/pen/retained`, `ink/render/retained`                                                  | Optional retained rendering with caller-owned identities, explicit updates and matching Pen bindings         |
| `ink/pen/workers`                                                                                               | Optional native Pen callback for bounded pure planning batches in isolated CPU workers                       |

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

`ink/radial` builds a row of overlapping soft circular masks. `Grid` owns its
cell count, origin and spacing; each `Vec4` stores x, z, radius and softness.
Inputs must be finite, cell count and spacing positive, radius nonnegative and
softness positive. `row grid circles z` preserves the maximum overlap and uses
SIMD for larger stamp batches. It owns no mutable world or cache.
