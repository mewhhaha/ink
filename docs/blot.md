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

`normalize_quat` and `normalize3` return `Maybe`, rejecting zero/non-finite
inputs and handling finite magnitudes without overflow. Zero-axis rotations use
identity; parallel look/up vectors choose a deterministic perpendicular axis.

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

## Cameras, colour and lighting

`camera.Camera` holds position, quaternion and a perspective/orthographic
projection. Distances are metres, vertical field of view is radians, NDC is +Y
up and WebGPU depth [0,1]. `valid` checks a projection; `valid_camera` also
checks the pose and nonzero quaternion. `project`/`unproject` and `pick_ray`
return `Nothing` for invalid inputs or non-finite results. `matrix` exports four
column vectors; it and `frustum` require a valid camera. `bounds_visible` and
`cull` test AABBs. Both depth directions are supported; quaternions are
normalized.

`color.linear`/`srgb` preserve alpha and HDR range. `expose` takes stops; `tone`
uses an ACES-inspired fitted display curve, not the full ACES pipeline;
`display` exposes, maps and encodes once. `exp2`/`log2`/`power` use
range-reduced polynomials because the pinned Blot prelude has no native exp/log.
Inputs must be finite; powers take nonnegative bases. `logarithm` checks
positive finite inputs; low-level `log2` floors positive subnormals to
1.17549435e-38. `exp2` bounds exponents to [-126,126]. Tone mapping handles
extreme finite HDR.

`lighting.Material` stores linear base colour, metallic, perceptual roughness
and emission. `brdf material normal view light` returns reflected response
including NoL, before incoming radiance; directions point out of the surface.
`sample` evaluates directional, inverse-square point or smooth-cone spot lights;
local lights have finite range. `shade` multiplies a sample by the GGX response.
`environment.sky` evaluates an authored sky. `integrate` takes
direction/radiance/ solid-angle samples, whose weights should sum to 4π;
`evaluate` returns diffuse irradiance from nine real SH coefficients, before
diffuse albedo/π.

`shadow.splits near far count blend` blends linear/logarithmic partitions.
`fit corners direction resolution padding` returns a snapped orthographic
camera; resolution must be at least two. The light direction points along its
rays. Rounded sphere bounds reserve snapping slack; padding admits off-screen
casters along the light axis. Retain cascade extent settings across small pans.

## Particles, motion and animation

`particles.emit seed count emitter` returns the advanced seed and new particles.
`update` advances a constant-acceleration ballistic step and removes expired
particles in stable order. `frame` supplies seeded atlas animation. `billboard`
returns [BL,BR,TR,TL] corners from position, camera quaternion, full Vec2 size
and in-plane rotation. `atlas_uv` is row-major with top-left UV origin.
`vertices` packs six triangle vertices per particle as xyz uv rgba (nine F32,
36-byte stride), facing camera-local +Z. Invalid atlas dimensions yield no UVs.

`motion` provides cubic easing, Bezier position/tangent and analytic scalar/Vec3
springs. Spring frequency is angular rad/s and damping is a ratio; constant
target responses cover under/critical/over damping. `kick`/`settle` and
`seeded_kick` carry explicit translation/rotation impulses for camera shake.
`checked_spring` validates finite values, nonnegative frequency/damping/dt and a
frequency × dt phase no greater than 8192; unchecked springs require those
conditions.

`animation.validate clip` is the import boundary: positive finite duration,
finite poses, sorted keys in [0,duration] and sorted events in [0,duration).
Duplicate keys choose the later value at that time. Validate once before
sampling/blending. `valid_parents` requires one parent per bone, with parents
preceding children and U32 max for roots. `root_motion` unwraps translation and
rotation through reverse/forward loops. Loop cycle indices must fit F32's exact
integer range (±2^24). `events` returns crossings in (previous,current]; reverse
windows return empty arrays. The loop cycle difference must be below 4096 and
the candidate cycle/event product must fit U32. Invalid windows produce neutral
root motion or no events. Event output storage is allocated once.

## Navigation, joints, placement and diagnostics

`navigation.grid width height costs` validates a finite four-neighbour grid.
Costs are row-major, positive to enter a cell, zero for walls.
`astar grid start
goal limit` returns `Maybe Path` with U32 cells, cost and
expansion count; the limit bounds work. `flow grid goal` returns reverse
shortest costs and successor indices; unreachable cost is 3e38 and the successor
sentinel is cell count. Keep path/field caches in the application and rebuild
when its map changes.

`steering.seek`, `arrive`, `separation`, `accelerate` and `limit` are pure Vec3
calculations. Supply neighbours from the application's spatial index rather than
asking every agent to scan the crowd. `in_fov`, `line_of_sight` and `visible`
combine a direction cone with scene rays; solids occlude, triggers do not.
Applications choose acceleration integration and perception query budgets.

`joints.distance`, `spring`, `hinge` and `motor` use U32 source indices, local
anchors in metres and local axes. Springs use N/m and N·s/m; motors use rad/s
and torque limits in Nm. `physics.step_joints joints config dt sources cache`
and `simulate_joints` interleave joint impulses with contact solving each
substep. Static anchors need no collider; dynamics use ordinary physics
colliders. Kinematic poses remain caller-owned. Invalid/self joints are ignored;
connected dynamics stay awake. There is one joint pass per substep, with no
angular limits, break thresholds or joint warm-start cache. Coupled chains may
need more substeps.

`placement.chunk seed cell spacing x z width depth` uses global integer cells
and deterministic priority thinning. Adjacent half-open chunks exactly join;
negative coordinates work within F32's exact integer range. Neighbour work grows
with spacing/cell. Points meet minimum spacing but do not form a maximal fill.
`choose weights seed` returns a weighted index and advanced seed; zero weights
are skipped and invalid/all-zero weights return `Nothing`.

`debug` returns ordinary lines for colliders, contacts, rays, paths and
skeletons. `vertices` packs line endpoints as xyz rgba (28-byte stride). The
caller supplies colours, buffers and the decision to draw them.

## Audio

`audio.mix config listener emitter blocked` returns `Maybe Mix` with gain,
equal-power pan input, Doppler rate and lowpass cutoff. `query` also performs
one scene ray along the listener/emitter segment after validating inputs,
skipping the emitter id and using caller layers. `fade` is a finite scalar
envelope. Query at the application's chosen cadence; interpolate presentation
values separately. The caller owns playback and the audio backend.

## Compiler notes

The exact upstream compiler pin lives in `deno.json`. `deno task toolchain`
records compiler and Deno/V8 versions. `deno task toolchain update
<commit>`
changes that pin; rerun setup and the full suite before accepting it. The
compiler cache verifies its complete payload and installs through a recoverable
atomic swap.

- Imported record parameters need explicit types. Accessing nominal fields of an
  untyped parameter in an imported module can fail with `missing_member`.
- Qualified values cannot always be projected: use flat exported names instead
  of `module.defaults.transform`.
- Negative literals passed as arguments need parentheses: `abs (-2.0)`.
- Parenthesize a bitwise-or array element: `#[0, (a | b)]`.
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
- `break` in an array-writing loop can disable reuse, including `for ever`
  exits. Prefer bounded loops with active guards. `deno task bench:compiler`
  compares increasing writes, pathfinding and U32 sorting against an intentional
  break control; numerical checksums accompany timings.
- Early exits can also defeat reuse of a growing list in the same function. For
  hot collectors, bind values before appending one item at a time, or count
  results and fill an exactly sized array. Spatial queries use private level
  frontiers to preserve pruning without early exits. Animation events use two
  passes to preserve F32 boundary behaviour and chronological ordering.
- Curried calls can capture mutable array lookups and make later writes copy
  storage. Bind lookup results to scalar locals before passing them to calls or
  compound comparisons; this removed two hot memory copies from pathfinding.
- `from x` inside a nested spread literal can fail with `constant_expression`;
  bind the conversion first or use `U32.to_f32`.
- Integer values sent through F32 arrays are exact only below 2^24. Use the
  guest's U32 ABI when full-width ids or seeds are needed. Physics caches keep
  ids in U32 records; a caller's F32 serialization can still truncate them.
- The allocation arena resets between guest calls. A single allocation-heavy
  call simulating hundreds of ticks can trap; advance state in bounded calls.
  `memoryBytes()` reports committed capacity, which remains allocated for reuse
  after the arena resets. See [benchmark scope and limits](benchmarks.md).
