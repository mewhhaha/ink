# Ink

Reusable game systems for [Blot](https://github.com/mewhhaha/blot2). One source
library, imported as `ink/*`.

```blot
import * as math from "ink/math"

entry const orbit = fn (angle: F32) -> Array F32 => do:
  let p = math.Quat.rotate (math.axis_angle math.up angle) math.forward
  return #[p.x, p.y, p.z]
```

## Use it

Clone or vendor this repository and map your Blot compiler's `ink/` alias to
`lib/`. The Deno/Node entry point supplies that location:

```ts
import { libraryUrl } from "./vendor/ink/mod.ts";

const imports = { "ink/": libraryUrl }; // Pass to Blot's createCompiler options.
```

A native compiler needs files on disk. When the package is imported over HTTP,
use `installLibrary` to write its sources into a directory you choose:

```ts
import { installLibrary } from "./vendor/ink/mod.ts";

const imports = { "ink/": await installLibrary("./vendor/ink-sources") };
```

## Modules

| Import                                                                                                          | Provides                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ink/changes`, `ink/pages`                                                                                      | Explicit invalidation batches and immutable paged values shared between snapshots                            |
| `ink/math`                                                                                                      | Vectors, quaternions, colors, rays and rotations                                                             |
| `ink/arrays`, `ink/sort`                                                                                        | Array copies and stable sorting                                                                              |
| `ink/time`, `ink/transform`                                                                                     | Explicit timers, fixed steps, affine transforms and pose interpolation                                       |
| `ink/random`, `ink/noise`                                                                                       | Explicit random state, seeded Perlin/value noise and fractal sums                                            |
| `ink/terrain`                                                                                                   | Heightfield sampling, normals, slopes, ground following and bounds                                           |
| `ink/tiles`                                                                                                     | Tile flags, queries and box movement through tile maps                                                       |
| `ink/shapes`, `ink/contact`                                                                                     | Convex shapes, casts and contact manifolds                                                                   |
| `ink/scene`                                                                                                     | Physics data types, scene construction and spatial queries                                                   |
| `ink/spatial`                                                                                                   | Bounding-volume trees with immutable refitting, uniform grids for points and extents                         |
| `ink/rigid`, `ink/character`, `ink/physics`                                                                     | Rigid bodies, character movement and deterministic simulation                                                |
| `ink/camera`, `ink/shadow`                                                                                      | Perspective/orthographic cameras, picking, frustum culling, stable shadow cascades                           |
| `ink/spline`, `ink/rig`                                                                                         | Constant-speed centripetal Catmull-Rom paths; follow, framing, collision and dolly camera rigs               |
| `ink/color`, `ink/lighting`, `ink/environment`                                                                  | HDR transfer/exposure/tone curves, GGX lights/materials, sky and SH irradiance                               |
| `ink/particles`, `ink/motion`, `ink/animation`                                                                  | Seeded particles, atlas sprites/billboards, easing/springs/shake, clips/blending/root motion/events          |
| `ink/tween`, `ink/timeline`                                                                                     | Data easings, generic tweens and slerp, keyed tracks, cues and loop/ping-pong playback                       |
| `ink/audio`                                                                                                     | Spatial gain, panning, Doppler, fades and scene occlusion                                                    |
| `ink/navigation`, `ink/steering`                                                                                | Weighted A*, flow fields, crowd steering, flocking, obstacle avoidance, field-of-view/line-of-sight          |
| `ink/joints`, `ink/placement`, `ink/debug`                                                                      | Distance/spring/hinge/motor constraints, seeded placement, drawable diagnostic geometry                      |
| `ink/ecs`, `ink/app`, `ink/clock`                                                                               | Typed resources and component columns, immutable snapshots, schedules and caller-selected fixed steps        |
| `ink/task_queue`, `ink/services/typed`                                                                          | Saved cross-frame work, lifetime epochs, ordered delivery and typed service responses                        |
| `ink/schedule`, `ink/partition`                                                                                 | Explicit access plans and balanced disjoint ranges; callers own execution                                    |
| `ink/claims`                                                                                                    | Bounded resource proposals with deterministic priority and owner ties                                        |
| `ink/handles`, `ink/derived`, `ink/behavior`, `ink/codec`                                                       | Stable typed objects, explicit derived resources, saveable logical-time behaviors and derived codec adapters |
| `ink/lanes`, `ink/persist`                                                                                      | Checked numeric codecs, exact U32 halves, versioned state and scene sections                                 |
| `ink/events`, `ink/input`, `ink/input/keys`, `ink/tune`                                                         | Normalized events, per-frame input and validated live values                                                 |
| `ink/ui`, `ink/ui/tree`, `ink/ui/font`, `ink/ui/vocabulary`, `ink/menu`                                         | Headless controls, text editing, caller fonts, layout, focus and accessible nodes                            |
| `ink/ui/split_flap`                                                                                             | Mechanical letter flips with clipped caller glyphs and a caller-controlled phase                             |
| `ink/preferences`, `ink/services`, `ink/text`, `ink/logic`                                                      | Preference values, bounded request queues, text helpers and eager Boolean operations                         |
| `ink/render`, `ink/view`, `ink/sound`, `ink/graphics`                                                           | Declarative draw/audio values, ECS camera poses, sky and snapped shadow preparation                          |
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
| `ink/pen/instances`                                                                                             | Optional retained-instance packets with stable IDs, upserts and removals                                     |

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

Requires Deno and Zig 0.17.0 for the initial test compiler build.

```sh
deno task check
deno task test
deno task test:shaders
deno task test:fast
deno task test:affected lib/time.blot
deno task example
deno task bench
deno task bench:library
deno task bench:library physics terrain
deno task bench:scene
deno task bench:game
deno task bench:compiler
```

`deno task setup` caches the pinned Blot compiler and standard library in
`.cache/blot/`. The [architecture notes](docs/architecture.md) describe
ownership and dependency boundaries. [API contracts](docs/blot.md) cover caller
state, packing and numerical conventions.

Use `test:fast` for local edits; `test:affected` follows transitive Blot
imports. `test:stress` and `test:integration` isolate longer checks; `test` runs
every Blot check. `test:shaders` checks the core shaders with native WebGPU.
`toolchain` records versions and updates the compiler pin.

Ordinary source edits skip archive packing in `test:affected`; run
`test:integration` before shipping.

Benchmarks retain numerical witnesses and report timings for compiler iteration,
every Blot module and scene updates in `.cache/bench-*.json`, with warmups,
sample spread and toolchain versions. `bench:library` also checks deterministic
replay, memory plateaus and adversarial input growth in isolated workers with
time/memory limits. See [the measurements and limits](docs/benchmarks.md).

Tests execute the README and API examples, check source boundaries, pack the
actual distribution with `deno pack`, and compile its installed Blot sources
from isolated HTTP and Node consumers.

`deno publish --dry-run` validates the JSR package; `deno pack --dry-run` lists
the Node archive's source installer, declarations and Blot modules.

`ink/radial` builds a row of overlapping soft circular masks. `Grid` owns its
cell count, origin and spacing; each `Vec4` stores x, z, radius and softness.
Inputs must be finite, cell count and spacing positive, radius nonnegative and
softness positive. `row grid circles z` preserves the maximum overlap and uses
SIMD for larger stamp batches. It owns no mutable world or cache.
