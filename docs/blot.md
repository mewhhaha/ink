# Library API

Import ordinary modules as `ink/math`, `ink/physics`, and so on. Their
definitions in `lib/` are the API; nothing is generated. Runnable examples live
in `examples/`.

## Math, arrays and random values

`ink/math` adds `Vec4`, `Quat`, `Color` and `Ray` to `std/vector`'s `Vec2` and
`Vec3`. Coordinates are right-handed, +Y up, -Z forward. Quaternions store
`[x, y, z, w]`; `a * b` rotates by `b`, then `a`. Helpers include `axis_angle`,
`yaw_pitch`, `look_rotation`, `facing`, `approach`, and the `Quat` and `Ray`
members.

`ink/arrays.copy` and `copy_u32` make independent arrays. `ink/sort.order keys`
returns indices in ascending key order; equal keys retain their original order.
`order_u32` does the same for full-width unsigned keys.

`ink/random.next seed` returns the next U32 state. Zero restarts from a fixed
seed. `unit state` maps the high 24 bits to `[0, 1)`. Save and advance the seed
in your own application data.

`ink/noise` supplies `perlin1`, `perlin2`, `perlin3`, `value2`, `fbm2`, `fbm3`
and `at`. The same seed and coordinates reproduce the same values. Fractal sums
return zero for zero octaves.

## Time and transforms

`ink/time.fixed step limit remainder delta` returns `Maybe Step`. Run its
`steps` updates of `step` seconds, carry `remainder` into the next frame, and
use `alpha` for presentation interpolation. The limit bounds catch-up work;
extra whole steps are discarded and reported as `dropped` seconds. A zero limit
drops all whole steps. Invalid/non-finite inputs return `Nothing`; elapsed
seconds must be nonnegative and the step must be positive. Elapsed accounting
follows F32 precision, including rounded whole-tick boundaries.

`timer duration` creates a `Maybe Timer`; `tick timer delta` returns a
`Maybe Tick` with the next timer, the one-time `expired` transition and unused
`overshoot` seconds. `done timer` reports completion. There is no hidden clock.

`ink/transform` has `Pose2`/`Pose3` for position, rotation and scale, and
`Affine2`/`Affine3` for a translation and basis columns. `affine2`/`affine3`
convert poses to bases. `point2`/`point3` include translation;
`vector2`/`vector3` transform directions without it. `compose2`/`compose3` apply
the child, then the parent, retaining shear from rotated nonuniform scales.
`inverse2`/`inverse3` return `Nothing` for singular/non-finite results.

`lerp2`/`lerp3` interpolate poses with linear position/scale and the shorter
rotation arc. The weight is unclamped; 3D rotations use normalized quaternion
interpolation. Angles are radians. These helpers organize calculations without
owning a transform hierarchy.

## Terrain

```blot
import * as math from "ink/math"
import * as terrain from "ink/terrain"

const ground = terrain.make math.zero3 8.0 1 #[0.0, 1.0, 2.0, 3.0] 0.0 1.0 0 0
entry const height = fn (x: F32) -> F32 => terrain.height ground x 0.0
```

`make origin size cells grid amplitude wavelength octaves seed` builds a
terrain. The square is centred on `origin`. Heights are metres, with
`(cells + 1)^2` samples laid out in rows from -Z and columns from -X. Apply any
height scale before passing the grid. A missing or short grid contributes zero
base height. The border value continues outside the square; procedural detail
continues too.

| Function                                         | Result                                             |
| ------------------------------------------------ | -------------------------------------------------- |
| `height t x z`                                   | World-space ground height                          |
| `ground t p`, `above t p`                        | Point on the ground; distance above it             |
| `inside t x z`                                   | Whether the point is inside the square             |
| `normal t x z`, `gradient t x z`, `slope t x z`  | Surface normal, rise per metre and steepness       |
| `normal_by t step x z`, `gradient_by t step x z` | Central differences at a chosen distance           |
| `stand t p lift`, `stick t p lift reach`         | Corrected position, normal and grounded flag       |
| `range t x0 z0 x1 z1`                            | Conservative ground-height bounds over a rectangle |

The default normal/gradient step is 0.5 metres. `stick` also holds a body a
short distance above the ground, useful while moving downhill. The caller
integrates velocity, applies gravity and clears downward velocity after landing.

`scene.ground id terrain` creates a finite static collider using the same
bilinear/procedural surface as `height`. Its footprint is the terrain square,
with vertical walls below its boundary; unlike `terrain.height`, collision does
not extend beyond that footprint. The collider is authored in world space;
source rotation/scale do not transform it, and it remains immovable.

Rays, capsule casts, overlaps, characters and rigid-body contacts all use that
surface. Closest-point refinement uses bounded numerical search at half grid
cell / quarter finest detail wavelength, with a 0.1 mm resolution floor; it is
not an analytic global-distance guarantee. Work grows with query footprint and
detail frequency. Collision bounds use -1e9 metres as their lower sentinel.

## Tiles

`ink/tiles.grid width height cell origin tiles flags` takes row-major tile ids
from the bottom left and a flag value per tile id. Combine `solid`, `oneway`,
`ladder` and `hazard` as bit flags. Id 0 is conventionally empty.

`tile_at`, `flags_at`, `touches` and `centre_of` query the grid.
`slide grid half drop position velocity dt` moves a box and returns its
position, velocity, grounded flag, wall direction and head collision. `drop`
lets it pass through one-way platforms.

## Physics

`ink/scene.Source` describes a world-space pose, collider, optional rigid body,
optional walker and convex brush planes. Build those values directly from your
application's data. Proxies and results refer to source array positions. Use
unique positive U32 `id` values for queries and deterministic pair ordering;
contact caches preserve all 32 bits.

`scene.source id position` supplies an empty source; `box id position size`,
`sphere id position radius`, `capsule id position radius height` and
`character id feetPosition` construct common colliders. `dynamic source` adds a
body. Override the ordinary `default_collider`, `default_rigid` and
`default_walker` values for custom tuning. `physics.default_config` and
`physics.empty_cache` supply the usual starting simulation values.

1. Build proxies with `scene.build sources`.
2. Query them with `physics.ray`, `sweep_sphere`, `sweep_capsule`,
   `overlap_sphere`, `overlap_capsule` or `point_solid`.
3. Call `physics.simulate config dt sources scene cache` to advance simulation.
4. Apply the returned `Result` values to their source indices and retain the
   returned contact cache for the next step.

`physics.apply sources results` applies those changes. The convenience
`physics.step config dt sources cache` builds a scene, simulates and returns
`(updatedSources, updatedCache)`. Nonpositive/non-finite dt performs no update.
For reused scenes, call `scene.update sources previousScene changedIndices`
before the next simulation. Include every source slot whose pose, geometry, body
kind, layers or other collider settings changed. Source count and collider
insertion/removal changes rebuild the scene. Old snapshots remain usable.

Queries use a bounding-volume tree and retain source-order results, including
nearest-hit ties. Refitting keeps the initial leaf partitioning; rebuilding can
improve pruning after widespread movement. Updates copy proxy/bounds storage to
preserve snapshots, while geometry work follows the dirty slots. `ink/spatial`
exposes the underlying `Bounds`, `build`, `query` and `refit` functions for
other uses; refit takes parallel arrays of changed item indices and replacement
bounds.

`Cache.contacts` is an array of `CachedContact` records with exact U32 `a`/`b`
ids, `point`, `normal`, `normal_impulse` and `tangent_impulse`. Retain the cache
returned by simulation, sorted by canonical id pairs. `touching cache a b`
reports contact for a pair; `contact_count cache` counts its points. Changing or
removing an id discards its old contacts. These are solver contacts; triggers
remain queryable through overlaps.

`Config` holds gravity, substeps and sleeping thresholds. Each `Result` contains
`source`, `position`, `rotation`, `rigid` and `walker`. Static sources are
unchanged; kinematic motion is supplied by the caller. For walkers, the caller
supplies velocity and integrates gravity/jumps before simulation. Rigid bodies
use the configured gravity and their `gravity_scale`.

Queries use a layer mask and, where applicable, an id to skip (0 means none).
Solid queries ignore triggers; overlap queries include them. Angles such as
`Walker.max_slope` are in degrees; quaternion rotation helpers use radians.

`ink/shapes` and `ink/contact` expose the convex geometry and contact routines.
`ink/rigid` and `ink/character` expose the lower-level body/controller helpers.
See [the minimal physics example](../examples/physics.blot),
[fixed steps with terrain and interpolation](../examples/steps.blot), and
`tests/physics.blot` for an explicit state-carrying simulation fixture.

## Compiler notes

Tests use upstream Blot `86a527b97c32331993c4a006da2c982a7336c365`.

- Imported record parameters need explicit types. Accessing nominal fields of an
  untyped parameter in an imported module can fail with `missing_member`.
- Qualified values cannot always be projected: use flat exported names instead
  of `module.defaults.transform`.
- Negative literals passed as arguments need parentheses: `abs (-2.0)`.
- Effectful calls need `use`; `let` and field updates must be pure.
- There is no `continue`; guard the loop body with `if`.
- A variant `case` arm containing statements needs `do:`. Imported constructors
  are qualified in expressions and patterns, such as `#scene.Dynamic`.
- Block `else if condition:` is unsupported; nest an `if` inside `else:`.
  Expression `else if condition then ...` remains valid.
- Named vector type imports support receiver calls such as `position.lerp`; use
  a namespace import for qualified functions such as `vector.Vec2.lerp`.
- Data records do not derive `==`; compare the relevant scalar fields.
- Only one spread is allowed per list literal. `array.concat` joins arrays; this
  compiler revision predates `list.concat` and `type Name = ...` aliases.
- A multi-line `case` cannot sit inside a record literal; bind it first.
- `of` and `data` are keywords. An untyped parameter is written `fn c =>`, not
  `fn (c) =>`.
- Rebinding array elements is cheap when a fresh local array stays inside its
  function. Passing it to another function, even to read it, can make later
  writes copy the whole array. Keep hot-loop reads/writes inline. Retained swap
  aliases can also defeat reuse. The sorters avoid excessive copying with fresh
  pass buffers and exact loop bounds.
- `from x` inside a nested spread literal can fail with `constant_expression`;
  bind the conversion first or use `U32.to_f32`.
- Integer values sent through F32 arrays are exact only below 2^24. Use the
  guest's U32 ABI when full-width ids or seeds are needed. Physics caches keep
  ids in U32 records; a caller's F32 serialization can still truncate them.
- The allocation arena resets between guest calls. A single allocation-heavy
  call simulating hundreds of ticks can trap; advance state in bounded calls.
