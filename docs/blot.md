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
`unit_quat`, `rotate_parts` and `nlerp_parts` are `Quat.normalized`,
`Quat.rotate` and `Quat.nlerp` over scalar parts, for kernels that keep values
in locals. `rotate_parts` is one body whose `(x, y, z)` tuple result is its only
allocation, for kernels outside loops; `Quat.rotate` inlines whole into loops.

`ink/arrays.copy` and `copy_u32` make independent arrays. `ink/sort.order keys`
returns indices in ascending key order; equal keys retain their original order.
`order_u32` does the same for full-width unsigned keys.

`ink/random.next seed` returns the next U32 state. Zero restarts from a fixed
seed. `unit state` maps the high 24 bits to `[0, 1)`. Save and advance the seed
in your own application data.

`ink/noise` supplies `perlin1`, `perlin2`, `perlin3`, `value2`, `fbm2`, `fbm3`
and `at`. The same seed and coordinates reproduce the same values. Fractal sums
return zero for zero octaves.

## Hash maps and sets

`ink/map` provides `Map [key, value]`; `ink/set` provides `Set key`. Both are
immutable values backed by a hash trie. Retaining an old collection retains a
snapshot: edits copy the path to the affected key and share other branches.
There is no capacity parameter, table-wide rehash, global state or hidden seed.
See the [runnable collection example](../examples/collections.blot).

`map.u32` and `map.text` are key policies. For custom keys, use
`map.key hash equal` (also `set.key`), with pure functions `key -> U32` and
`key -> key -> Bool`. Equality must be reflexive, symmetric and transitive;
equal keys must hash equally. Use the same policy throughout a collection's
lifetime and across both operands of set operations. Policy is supplied
separately from storage, so applications own hashing seeds and saved formats.

| Map operation | Result |
| --- | --- |
| `empty ()` | Empty map; annotate `map.Map [U32, Text]` when inference needs key/value types |
| `from policy entries` | Build from `(key, value)` pairs; later equivalent keys replace values |
| `get policy key map` | `Maybe value`; a stored `Nothing` remains distinguishable from absence |
| `contains policy key map` | Whether the key is present |
| `set policy key value map` | Insert or replace, retaining the original equivalent key |
| `remove policy key map` | Remove; an absent key leaves the map unchanged |
| `alter policy key change map` | Call `change` on the old optional value exactly once; `Nothing` removes |
| `edit_many policy edits map` | Apply ordered `(key, Maybe value)` edits; `Some` sets and `Nothing` removes |
| `set_many policy entries map` | Apply ordered `(key, value)` pairs |
| `remove_many policy keys map` | Remove the requested keys |
| `count map`, `is_empty map` | Constant-time size queries |
| `entries map`, `keys map`, `values map` | Arrays in deterministic traversal order |
| `fold reduce initial map` | Pure reduction; `reduce state key value` visits each entry once |

`from` and the batch operations group edits by trie path, rebuilding affected
branches together and sharing untouched branches. Equal-hash edits retain their
input order. Their result, including enumeration and the stored representative
of equivalent keys, matches ordered individual edits: replacement keeps the old
key, while removal followed by insertion adopts the new key. Empty batches keep
the original map. Tiny construction uses individual inserts; full-hash collision
buckets still require key comparisons and can take quadratic construction work.
`alter` reads and edits through one trie descent and calls its callback once.

Sets accept the same policies (`set.u32`, `set.text`, or a custom `map.Key`).
Use `empty ()`, `from policy keys`, `insert policy key set`, `remove`,
`contains`, `count`, `is_empty`, `values`, and `fold reduce initial set`.
The set reducer receives `state key`. `union policy left right`, `intersection`,
`difference`, `is_subset` and `equal` preserve their inputs. Duplicate insertions
do not increase the count; `difference` removes right-hand members from the left.
Set construction, union, intersection and difference use grouped map edits.
They retain the same representative keys, collision order and earlier snapshots
as the corresponding ordered individual operations.

`ink/hash.u32` mixes all 32 input bits. `hash.text` hashes exact Unicode scalar
sequences, matching `std/text.equal`; it does not normalize text or fold case.
`hash.combine left right` composes ordered hash components for custom keys.
These are deterministic collection hashes, not cryptographic hashes. There is
no default F32 key policy: callers must choose equality and hashing together,
including their handling of NaN and signed zero.

The trie consumes five hash bits per level, with at most seven branch levels.
Full-hash collisions compare actual keys in a leaf. Ordinary operations touch
one bounded path; a collision bucket costs linear work in its size, and building
an all-colliding collection costs quadratic work. Enumeration is linear in the
entries and branches. It follows ascending slots at each level, then insertion
order within full-hash collisions. This is reproducible for the same policy and
edits, but neither sorted-key nor global insertion order. Sort an extracted key
array when presentation or serialization requires a particular external order.
Codecs remain caller-owned: serialize entries and reconstruct with `from` and
the matching policy, rather than depending on internal nodes.

Maps and sets use nominal data wrappers. On compiler `a440ea28`, opaque
generic wrappers stored inside ECS resources fail with `InvalidArtifact` in
larger application fixtures, even though standalone collection tests pass.
Gdev's `cannon_blast`, `cannon_switch` and `ascension_feedback` fixtures exposed
this during integration. Replacing both opaque wrappers with tagged data
wrappers allows compilation; replacing only Map leaves Set affected. The
collection constructors and operations still own the storage invariants.

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
improve pruning after widespread movement. Scene proxies use persistent pages;
`scene.count scene`, `scene.proxy scene index` and `scene.proxies scene` replace
direct array access. The last materializes a contiguous view for full scans.
Dirty updates copy touched pages and share unchanged geometry and storage.
Dense edits retain a contiguous copy-and-recompute path.

`ink/spatial` exposes `Bounds`, `build`, `query` and `refit`; refit takes parallel
arrays of changed item indices and replacement bounds, ignores invalid indices
and keeps the last replacement for duplicate indices. Length mismatch traps.
Indexes start contiguous. A sparse update to at least 2,048 items converts bounds
once to shared chunks of 32 nodes. Later updates copy only dirty chunks and their
ancestor paths. Edits to at least one eighth of the items use the dense path.
`Index.bounds` is paged; `node_page index node` and `node_offset index node`
address its six bounds lanes, and `flat_bounds index` materializes all lanes.
`refit_dense` exposes the contiguous alternative with the same parallel inputs.
The immutable nearest-point index is now `spatial/points.Index`; its bounds stay
contiguous, and callers rebuild it when positions change.

`spatial.any index low high accept` stops at the first accepted intersecting
leaf. `closest index lower test score limit` visits nearer branches first and
returns `Maybe (Nearest value)`. `lower lanes offset` must conservatively bound
every descendant's score using its six AABB lanes; positive infinity rejects a
branch. `test sourceIndex` returns an optional value, `score value` gives its
score, and the limit is inclusive. Callbacks are pure and may run in tree order.
Exact score ties choose the smaller source index. Scene casts and point-solid
queries use these traversals without collecting or sorting all candidates;
overlap queries still return source-ordered results.

`spatial.cells size points` buckets points on the floor plane (x, z) in a
uniform grid over their bounds, by a counting sort in linear time; build it
afresh when points move. `near cells points at radius` returns the indices
within the radius, ascending, visiting only the cells it overlaps. Points with a
non-finite x or z are left out. The grid holds at most four cells a point plus
64, growing its cells past `size` to stay within that; a size that is not
positive and finite makes one cell.

`spatial.areas size bounds` lays out `Bounds` with extent in the same `Cells`:
each item is listed, ascending, in every cell its x and z overlap; non-finite or
inverted bounds are left out. Cells grow by a quarter until there are at most
four cells and eight listings an item, each plus 64. A size that is not positive
and finite starts from half the square root of the area per item. `span` with no
reach finds a point's cell.

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

`director` blends the camera between shots: rigs the game evaluates by U32 id.
`Pose` holds a `view.Camera` and a focal length (as `view.Lens`). `Pose.lerp`
lerps position, slerps rotation and moves focal length by equal ratios, so a
zoom looks even whether reckoned in focal length or in the tangent of half the
field of view, and stays positive when an ease overshoots. Focal lengths that
are not positive and finite lerp. Weights 0 and 1 return the end poses exactly;
poses tween with `tween.at`.

The caller owns the `Director`: the live shot, the blend's source (a live shot,
a frozen pose or none), elapsed and duration seconds and a `tween.Ease`. `start`
and `cut state shot` settle on a shot. `blend state shot duration ease poses`
evaluates shots through `poses: U32 -> Pose`. From a settled director the
outgoing shot stays live; interrupting a blend freezes the pose reached as the
new source, so the camera never jumps. Blending to the live shot changes
nothing, leaving a blend under way to finish; a zero duration cuts. `advance`
drops a finished blend's source and `blending` reports one under way. `pose`
evaluates both shots each frame and blends them by eased progress. Negative or
non-finite durations, seconds or state times return `Nothing`.

`shaken pose impulse` applies a `motion.Impulse` in camera axes (+X right, +Y
up, +Z back): translation in metres, rotation as an axis scaled by its angle in
radians, turning after the camera's rotation. Impulses must be finite. `lens`
substitutes the focal length into a caller's `view.Lens`; `matrix` and
`projection pose lens aspect` give the view and projection; `framed camera lens`
makes a pose. The codec (key 18) has sixteen lanes, with a fixed eight for the
blend source; shot ids and step counts use `lanes.halves`.

`spline.make points` returns a `Maybe Spline`: a centripetal Catmull-Rom curve
(alpha 0.5) through every point, without cusps or self-intersections within a
segment. Its ends continue their first chords. `make_loop` closes the curve back
to its first point, dropping a last point that repeats the first. A point within
a micrometre of the last kept point is skipped. Open curves need two distinct
points and loops three; a non-finite point or an overflowing length returns
`Nothing`. Construction measures 16 samples per segment by Gauss-Legendre
quadrature into a compensated arc-length table, so a straight line's length is
exact to F32 rounding. `length` is in metres. `at spline distance` and the unit
`tangent` find the sample by binary search and refine the curve parameter with
two Newton steps: points lie on the curve, and equal distance steps cover equal
arcs. Open curves hold distances to [0, length]; loops wrap them. A non-finite
distance gives the start. `marks` lists each kept point's distance along the
curve.

`rig` makes `view.Camera` poses with pure functions over caller-owned state;
cameras look down -Z with +Y up. `look_at eye target up` uses
`math.look_rotation`, so an eye on its target looks down -Z.
`turn current desired rate dt` slerps by 1 - e^(-rate × dt), turning toward a
fixed rotation alike however the time is split. A nonpositive or NaN rate × dt
keeps the current rotation; an infinite rate snaps.

`Follow` settings hold the eye's offset from the focus (world axes, or turned by
the target's yaw heading when `turns`), a dead-zone radius in metres, lookahead
seconds, spring frequency (rad/s) and damping ratio, and a turn rate.
`valid_follow` requires them finite and nonnegative; steps must also keep
frequency × dt within `motion.checked_spring`'s limit.
`follower settings target velocity heading` starts settled on the target's lead
point. `follow settings state target velocity heading dt` returns the next
`Follower` and its camera. The lead point, target + velocity × lookahead, drags
the anchor only when it leaves the dead zone, keeping it on the zone's edge. The
focus springs after the anchor and the eye after the anchor plus offset, so a
fixed offset keeps its view while following. Both treat their goals as moving
steadily through the step, which is exact for steady motion and keeps results
within millimetres across frame rates. The rotation turns toward the focus. A
nonpositive or non-finite dt keeps the state. Start a new follower after a cut
or teleport.

`frame lens aspect rotation points padding` returns the nearest eye position,
for that rotation, that keeps every point at least `padding` radians inside the
frustum's sides and no nearer than the near plane. The points fill the padded
view across one axis and are centred on the other. It returns `Nothing` for no
points, non-finite values, a nonpositive aspect or focal length, padding outside
[0, half the field of view), or points too deep for the far plane.

`collide world pivot eye radius mask skip` sweeps a sphere from the pivot toward
the eye with `scene.cast` and the solid filter (`mask` layers, never `skip`, no
triggers), returning the centre where it first touches, or `eye` unchanged when
clear. Any proxy counts, terrain included: keep the pivot more than the radius
from solids and above the ground, since a sphere starting inside one stops at
the pivot, or leave that layer out of `mask`. Non-finite input returns `eye`.
`dolly path distance aim` places a camera at `spline.at`, aimed `#Along` the
tangent, `#At` a point (along the path when on it) or `#Fixed` with a normalized
rotation.

[The cinematic example](../examples/cinematic.blot) puts these together: a
timeline track drives a dolly's distance and focal length, cues hand off to a
follow rig through a director blend and kick a shake.

## Particles, motion and animation

`motion.integrate acceleration dt position velocity` performs one semi-implicit
Euler step and returns `(position, velocity)`: velocity changes first, then the
new velocity advances position. `integrate4` accepts four positions and four
velocities as `std/simd.F32x4` tuples. `integrate_columns` accepts two equally
sized `Array F32` columns and returns two new columns; a length mismatch traps.
All three preserve scalar operation order, including signed zero, and leave old
snapshots intact. Inputs and timestep are finite caller-owned values; signed
timesteps are supported. Overflow follows ordinary F32 arithmetic.

These operations supply integration only. Applications own forces, contacts,
sleeping, timers and state layout. Numeric columns make SIMD useful when
retained between steps; converting application records into columns and back on
every call can cost more than the arithmetic saves. Packed structural records
are a separate option when callers need several related fields together.

`particles.emit seed count emitter` returns the advanced seed and new particles.
A `Particle` is a flat record of scalars (position `x`, `y`, `z`, velocity `vx`,
`vy`, `vz`, `age`, `lifetime`, `size`, `rotation`, `seed`), so particle arrays
store their fields in place; `position` and `velocity` give the vectors.
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
sampling/blending. `sample_track` finds that boundary with a logarithmic
upper-bound search, bounded to 32 iterations for U32 array lengths.
`valid_parents` requires one parent per bone, with parents preceding children
and U32 max for roots. `root_motion` unwraps translation and rotation through
reverse/forward loops. Loop cycle indices must fit F32's exact integer range
(±2^24). `events` returns crossings in (previous,current]; reverse windows
return empty arrays. The loop cycle difference must be below 4096 and the
candidate cycle/event product must fit U32. Invalid windows produce neutral root
motion or no events. Event output storage is allocated once. An `Event` is the
record `{ time, id }`.

`tween.make from to start duration ease` returns `Maybe Tween`. Times are the
caller's seconds; non-finite times, a negative duration or an overflowing end
are refused, and zero duration jumps at `start`. `at tween time` holds `from`
before the start and `to` from the end; `progress` is the linear fraction and
`ends`/`done` give the end. Values tween through their type's own `lerp`,
wherever it is declared: F32, Vec2, Vec3, `math.Color`, `math.Quat` (slerp) and
a game's types. `Discrete` holds its start until the eased progress reaches 1.
`Ease` is data. `eased` clamps progress to [0,1] (NaN counts as 0), gives
exactly 0 and 1 at the ends and keeps rounding below 1 before the end, so
discrete values switch on time; only `Back`, which overshoots by about a tenth,
passes 1 early. `Steps n` rises in n jumps; zero steps holds like `Hold`.
`toward tween time to duration ease` starts a new tween from the current value,
so a redirect never jumps. `reversed` swaps the ends and keeps the ease.
`math.Quat.slerp` turns at constant angular speed along the shorter arc and
falls back to normalized interpolation within about 0.063 radians.

`timeline.track keys` validates a non-empty key list: finite, nondecreasing
times with gaps inside F32's range. A key's ease shapes the segment arriving at
it. `sample track time` holds the first value before the first key and the last
from the last key; equal times switch there, the later key winning, as in
`animation`. Its upper-bound search is bounded to 32 steps. `starts`/`ends` give
the keyed span. `cues list` validates finite, nondecreasing cue times; equal
times keep their order and the list may be empty. A `Cue` is the record
`{ time, value }`.

`timeline.play duration mode` starts a `Playback` at 0, playing at speed 1; the
duration must be positive and finite. `Once` stops at the end, `Loop` restarts
and `PingPong` turns back. `time`, which `position` returns, stays between 0 and
the duration. `with_speed` takes a finite speed; negative plays backwards.
`pause`/`resume` set `playing`; `seek` clamps the time and fires nothing.
`advance playback dt` returns `Maybe Advanced`: the new playback, the passes it
traversed in order and `finished` when a Once playback reaches its end, which
stops it (seek to replay). dt must be finite and nonnegative and dt × speed
finite. An advance returns at most 64 passes: the way to the next end, whole
traversals and the final part. Whole traversals past 62 are dropped and reported
as `dropped` local seconds, in pairs for a ping-pong so the passes stay
continuous. Splitting follows F32 precision, as `time.fixed` does.

`fired cues passes` returns cue values in traversal order: a forward pass fires
(from, to], a backward pass [to, from); equal-time cues fire in list order
forwards and reversed backwards. A pass also fires at `from` (`inclusive`) only
after `play`, `seek` or a loop restart, so each instant passes once: a cue at 0
fires when playback starts and at each loop restart, a cue at the duration at
the end of each forward cycle, and a ping-pong passes each end once per turn.
Landing exactly on a loop's end restarts on the next advance. The output is
allocated once at its exact size. `timeline.codec` (key 17) saves time,
duration, speed, mode, playing, `returning` (a ping-pong's way back) and `fresh`
(the next pass includes the time).

## Navigation, joints, placement and diagnostics

`navigation.grid width height costs` validates a finite four-neighbour grid.
Costs are row-major, positive to enter a cell, zero for walls.
`astar grid start
goal limit` returns `Maybe Path` with U32 cells, cost and
expansion count; the limit bounds work. `flow grid goal` returns reverse
shortest costs and successor indices; unreachable cost is 3e38 and the successor
sentinel is cell count. Keep path/field caches in the application and rebuild
when its map changes.

`steering.seek`, `arrive`, `separation`, `alignment`, `cohesion`, `accelerate`
and `limit` are pure Vec3 calculations. Supply neighbours from the application's
spatial index rather than asking every agent to scan the crowd. `in_fov`,
`line_of_sight` and `visible` combine a direction cone with scene rays; solids
occlude, triggers do not. Applications choose acceleration integration and
perception query budgets.

Flocking (boids) runs over a `steering.Flock`: `flock` takes a cell size and
parallel arrays of positions, velocities and groups, bucketed by
`spatial.cells`. Rebuild it from the members' state each step, so every member
reads the same snapshot. `neighbourhood` takes the flock, a member's index, a
radius, a spacing and a most. In one pass over the nearby cells it gathers the
count, centre and mean velocity of the same-group members within the radius, and
the separation push (as `separation`) from every member within the spacing. It
takes at most `most` members within either, the first met in cell order, which
bounds a dense crowd's work. Coincident members push along a direction fixed by
the index, so a stack parts deterministically. A member placed at
`steering.nowhere` takes no part. The result is a flat record: `count`, centre
`cx`, `cy`, `cz`, heading `hx`, `hy`, `hz` and push `px`, `py`, `pz`; `centre`,
`heading` and `push` give the vectors.

`flocking` takes `Flocking` rules, a member's position and velocity, its goal (a
desired velocity from `seek`, `arrive` or a wander), its neighbourhood and the
step's seconds, and returns the new velocity. It weighs the goal, alignment,
cohesion and separation by the rules' gains and caps the acceleration. It then
holds the result within `stray` radians of the goal's direction, within `turn`
radians a second of the old velocity, and under the top speed. A stray below a
right angle keeps a member with a goal gaining on it, so it cannot circle it.
`within_angle` is that turn limit on its own. The caller owns the members' state
and the timestep. To keep members off obstacles, add `avoid`'s change to each
goal before `flocking`; the stray then holds the heading near the steered goal.

`avoid world position velocity goal radius ahead mask skip` returns a change to
add to the goal. It makes one cast of a sphere along the velocity for `ahead`
seconds, using the solid filter: `mask` layers, never `skip`, no triggers. Any
proxy counts, terrain included: cast from above the ground or leave its layer
out of `mask`. A clear way, no motion or a non-finite input gives zero. A hit at
distance d of the reach L has urgency u = 1 - d/L. The change removes u of the
goal's part into the surface and turns it along the surface, so a member slides
along a wall rather than stopping or hovering before a target behind it. It
turns the way the member already slides, else the way the goal leans, else to
the member's right. It also pushes out along the normal by u times the goal's
speed; a member starting inside a solid is pushed out. The change scales with
the goal, not the velocity, so a slowed member still resists a strong goal.
Choose `ahead` to fit the members' turn rate and acceleration. Physics stops
what steering misses.

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

## ECS, schedules and persistence

`ecs.membership_revision ()` and `ecs.component_revision #Component` read
world-local U32 revisions without materializing columns. Spawn/despawn and
whole-entity replacement bump membership; component sets/removals, bulk updates
and replacements bump the column. Pair both revisions when caching live rows.
They are conservative write revisions, not a promise that values differ.
Exhaustion traps instead of wrapping. Keep caches in the same immutable world;
independent forks can have equal revision numbers and must not share caches.

`ecs.insert_observed_resource equal value` and
`app.insert_observed_resource equal codec value` opt a resource into semantic
revision tracking. `ecs.revision value` changes only when `equal` rejects a
write. The latest value is always stored. The ordinary codec saves its value;
revisions and dependent caches start cold on restoration.

`ecs.new`, `register_component` and `insert_resource` construct a typed world.
`ecs.build` finishes its schema; `ecs.create` and `ecs.run` return a new world
and the action's result. Register a type once as a resource or component.
Components require an alive entity scope. Removed entities cannot be accessed;
despawn releases their current component payloads through registered maintenance
providers. IDs remain monotonic until an explicit compaction. `checkpoint` preserves opt-in snapshots read through
`previous` and `previous_components`. Retaining a world retains its values.

`ecs.view constructor` and `previous_view constructor` expose immutable column
snapshots without allocating an array of every entity slot. `ecs.read view id`
returns its optional component, filtering the view's captured alive bits and
bounds. Retained views keep their old values across subsequent world edits.
`present`, `query` and `query_pair` intersect occupied leaf masks with captured
alive bits; historical empty slots do not require per-entity reads. Queries keep
their starting membership even when callbacks edit the world. Paired and
triple-column updates build result leaves together, preserving entity order,
sparse/missing components and previous-step snapshots.

`app.new policy` adds lifecycle resources. `new_with policy route settle` also
accepts an event routing function and an end-of-render callback. Choose
`with_saves saves policy` or `new_saving saves policy route settle` to use
another persistence backend, including `persist/words.new`. Add plugins and
Start, Interface, Event, Update or Render systems explicitly, then `build`.
Interface systems run while paused; game events and updates wait. Applications
choose their initial resources and adapters. Transient resources reset each
frame; unsaved resources supply configuration; saved resources use codecs.

`app.render_if condition plugin builder` gates only the plugin's newly added
Render systems. Its input, state synchronization and fixed updates keep their
schedules. Use it for presentation that another scene replaces; stateful render
preparation must remain scheduled when its synchronization is still needed.

`app.add_named_system stage name system builder` adds diagnostic text alongside
a system; `add_system` leaves its name empty. Names never enter saved state.
`app.observed observer application` brackets calls, including `run_if` guards,
without changing the world. The observer receives stage (U32), registration
index (U32) and name (Array U32), and constructs `(begin, end)` callbacks taking
Unit. These callbacks are prepared once, outside the measured call. Stage
numbers are Start 0, Route 1, Interface 2, Event 3, Update 4, Render 5,
Settle 6. Paused or otherwise unvisited stages produce no calls. An aborted
system does not reach its end callback; hosts must close unfinished spans on
failure.

The optional `ink/pen/host.run_traced` adapter uses this observer through the
explicit Pen host capability. Expose it as `main_trace` beside the ordinary
`main`; native Pen selects it with `PEN_TRACE_SYSTEMS=FILE`. Markers stay
outside the game command stream. Allocation accounting belongs to the
instrumented host; it measures requested bytes, including reuse, rather than
retained memory.

`clock.Policy` chooses `step_seconds`, `max_elapsed` and `max_steps`. `advance`
checkpoints before each fixed update and returns `time.Step`, including dropped
seconds above both limits. Its U32 tick wraps. Saved ticks, ids and seeds use
`lanes.halves`/`whole` so F32 storage preserves every bit.

`lanes.Codec` has a unique key, layout version, encode/decode functions and an
optional migration. Change the version whenever lanes change. `persist` owns
numeric framing, validates section sizes and rejects duplicate keys, invalid
counts and nonfinite values. Unknown or unsupported sections reset only their
type. Applications own the overall schema number and file storage.

## Input, UI and requests

`events` defines normalized input and service replies. `input` tracks per-frame
keys, pointer motion and claimed clicks. Applications select key bindings and
translate host events; core modules have no native protocol dependency. Its
`SessionStarted { restored }` event marks a new host session after its initial
world is ready, not hot reloads, quickloads or timeline restores. Input releases
saved keys and buttons; applications choose any startup presentation. The input
codec accepts at most 512 held and 512 newly pressed keys, and eight pointer
buttons (1,039 lanes total). Duplicate keys are rejected without changing their
declared order; oversized layouts fail before decoding their arrays.

`ui/font.Font` carries a material and caller-provided glyph lookup, ascent,
descent and distance-field spread. Pass it to text and menu functions. `ui/tree`
owns layout, semantic nodes, modal focus and action routing; hidden or disabled
ancestors make their children unavailable. Empty choices and invalid control
indices remain inactive. Slider steps are relative to the lower bound; step zero
gives continuous values. `ui/vocabulary` defines host-independent roles, states
and actions. Hosts adapt the tree to their accessibility APIs.
`ui/tree.parents_of nodes` resolves each parent to its first declared index, or
`nodes.length` when absent, preserving full U32 ids. Focus settlement reuses
these indices and bounds each ancestor walk to 64 nodes; cycles are unavailable.

For a stable hierarchy, `ui/tree.prepare revision authoredNodes` builds a
caller-owned `Prepared` value. `update_prepared revision authoredNodes dirty
previous` reuses topology and updates inherited visibility/availability from
dirty roots through their descendants. Text/value edits reuse all derived
focus lists. Supply every changed source index, and change the revision when
IDs, parent IDs or source order change. Revision or length changes rebuild;
reported ID/parent edits without a revision change trap. Missing parents,
cycles, duplicate IDs and the 64-node ancestry limit retain ordinary semantics.

Pass `prepared_tree prepared` to the normal ECS settlement, or call the pure
`resolve_prepared prepared focus` to obtain `(Tree, Focus)`. Keep the original
authored nodes separate from the returned nodes with inherited hidden/focus
marks. Use `from_nodes nodes` for ordinary trees; `Tree` now also contains an
optional preparation, and `declare`/`declare_many` invalidate it. Cache lifetime
and revisions belong to the caller; preparation introduces no global state.

`ui.decimal` and `text.fixed` clamp fractional places to six. Decimal trims
trailing zeros; fixed pads to the clamped count. They split whole and fractional
parts before scaling, so large whole values retain their magnitude. Finite
magnitudes at least four billion use a decimal mantissa and `e` exponent;
rounding applies to the mantissa. NaN and infinities produce `NaN`, `Infinity`
and `-Infinity`. Rounded zero has no sign. `text.shown` selects the shortest
decimal within six places. These are bounded F32 display helpers, not arbitrary
precision or JavaScript number serialization. `text.power` performs at most 39
multiplications: exponents from 39 onward return positive infinity. `text.rest`
clamps starts to the code point array's length, returning empty text past its
end. `text.joined` fills one exact-sized code point array and rejects U32 length
overflow. `words` and `lines` collect their parts once; none of these helpers
repeatedly copies a growing output array.

`services` queues numeric requests and assembles replies without executing them.
Applications supply `Policy` (retry ticks, attempts, retained answers),
operation meanings and a host adapter. Requests deduplicate by payload, ids skip
outstanding requests and replies, and queue/data sizes are bounded. Retry
elapsed time uses wrapping U32 tick subtraction; choose intervals below half the
tick range. `preferences.make` takes caller quality, volumes and controls;
`tune` validates finite ranges and supports pure reads or ECS resources.

## Editing and presentation

`render` and `sound` declare draw and playback values; hosts execute them.
`view` combines saved camera poses with a caller's unsaved `Lens`. `camera`
supplies checked standalone projection math. Viewport helpers assume positive,
finite dimensions and focal length, an ordered near/far range and unit
rotations. `orbit` takes bindings and speeds. Its `Settings.overlook` permits
backing outside `room` while the viewing segment still reaches that circle;
outward-facing views stay inside. Disable it for a strict cylindrical bound.
`daylight` takes a day duration and palette. `editor` takes assets, words and a
clipboard callback. Those values belong to the application.

`brush` validates bounded convex geometry before constructing hulls; authored
edits retain deterministic corners and faces. `path.along` returns `Nothing` for
empty paths and handles repeated points. `navigation/ground.make` takes boxes,
rounds and an arena radius. It validates static obstacles once, returning
`Nothing` for a negative or non-finite radius, non-finite values, empty boxes or
negative round radii, and buckets them with `spatial.areas`. `closed` is an
obstacle-free ground of radius zero, a fallback when `make` refuses. `clear`,
`push_out` and `line_clear` then visit only the obstacles listed in the cells a
point or segment touches, so cost follows nearby obstacles, not their total;
building is linear in obstacles and covered cells. Up to three obstacles share
one cell, where a scan is cheaper. `line_clear` checks complete segments against
widened boxes and circles, avoiding thin-obstacle tunnelling; boundaries stay
traversable. `push_out` leaves the first obstacle containing the point: rounds,
then boxes, in order. `polar.Grid` supplies the centre, inner radius, ring width
and ring count. `noise.authored_hash2` and `authored_value2` take authored scale
and offset; `bspline_weights` supplies cubic spline weights without importing a
renderer.

See [application state mechanisms](state.md) for handles, derived resource
contracts, behavior stepping and codec generation.

## Compiler notes

`pen.json` selects the native compiler, its standard library and import aliases.
To qualify a compiler update, change those settings and run `pen test-blot` and
`pen tool ink -- bench`. Benchmark reports record compiled Wasm and dependency
hashes. The native toolchain replaces the former separate compiler download and
JavaScript generator cache.

Compiler SHA-256 `fd2119f5528cb164` accepts the new `@array.flatten` intrinsic,
but inferred arrays of generic nominal records can return corrupted rows. A
[standalone reduction](../tools/experiments/2026-10-26-generic-record-array.blot)
shows the inferred form failing while the same construction with an explicit
array and callback result type succeeds. The inferred form also fails with the
previous standard library, while compiler `af349b1e6f391f7b` passes it. Ink's
`task_queue.submit_many` now uses the explicit form; its queue cases pass on both
compilers. This is a compiler-version regression, not evidence that the flatten
intrinsic is responsible. The parent compiler should preserve the instantiated
row layout across generic array construction and return.

- Imported record parameters need explicit types. Accessing nominal fields of an
  untyped parameter in an imported module can fail with `missing_member`.
- Imported modules cannot declare `entry`; keep executable fixtures separate
  from shared helpers.
- Qualified values cannot always be projected: use flat exported names instead
  of `module.defaults.transform`.
- Negative literals passed as arguments need parentheses: `abs (-2.0)`.
- Parenthesize a bitwise-or array element: `#[0, (a | b)]`.
- Effectful calls need `use`; `let` and field updates must be pure.
- A leaked effect in a callback can be reported at the enclosing application's
  constant. Pass configuration to pure geometry helpers explicitly and keep ECS
  reads inside the system's `use` scope.
- Annotate a custom app event route's input when the application is used only
  for persistence. An unconstrained identity callback has no event call site to
  close its type. `app.with_saves` supplies a typed default route.
- The current compiler accepts `continue` in loops; older pins required an `if`
  guard around the remaining loop body.
- A variant `case` arm containing statements needs `do:`. Imported constructors
  are qualified in expressions and patterns, such as `#scene.Dynamic`.
- Block `else if condition:` is unsupported; nest an `if` inside `else:`.
  Expression `else if condition then ...` remains valid.
- Named vector type imports support receiver calls such as `position.lerp`; use
  a namespace import for qualified functions such as `vector.Vec2.lerp`.
- Data records do not derive `==`; compare the relevant scalar fields.
- `Bool` has no `==` or `!=`; the `missing_associated` error points into the
  prelude, not the comparison. Match both values with `case` instead.
- Only one spread is allowed per list literal; join with `array.concat` or
  `list.concat`.
- A multi-line `case` cannot sit inside a record literal; bind it first.
- `return value` exits the function; `break value` finishes the nearest `do`.
  Use `break` for expression-block results, including `case` arms and top-level
  initialization. Bare `break` still exits the nearest loop. A return cannot
  cross a monadic continuation; finish its block with `break`.
- Dynamic ECS builders capturing reference-valued local resources can still fail
  ownership proofs on this pin. Build the simulation schema once at module scope
  and install runtime values through scoped `ecs.set`; services and editor
  fixtures exercise this form. Annotate the cell and world parameters of generic
  builder helpers so native emission sees their concrete shapes.
- Importing upstream `std/text` can fail retained compilation with
  `InvalidArtifact` on this pin. Codec generation does not import it; semantic
  descriptors use code point arrays. Core Ink's existing `ink/text` is
  unaffected. Generic concatenation of JSON Text literals also reproduced
  `InvalidArtifact`; `ink/pen/semantic` uses concrete scalar-array tokens and
  `ui.digits` instead. Its Unicode and full-width U32 regression covers the
  resulting bytes.
- Positional parenthesized arrays of user-defined codec types are outside the
  qualified derivation path. Use named record fields for nested arrays, and
  derive their element types before their containers. See [state](state.md).
- A `:=` inside a nested `do:` block that nothing reads is rejected
  (`dead_rebinding`); rebind with `if`/`else`, a statement `case`, or assign a
  case expression.
- `of`, `data` and `complete` are keywords. An untyped parameter is written
  `fn c =>`, not `fn (c) =>`.
- A value whose type stays open only at call instances of a named generic
  function, rather than at a local's use, can still be rejected with
  `ownership_unproved`; blot2's app-runtime repro hits it through `application`.
  See [blot2 #10](https://github.com/mewhhaha/blot2/issues/10).
- Selecting `application.names` directly from a polymorphic module-level
  application can emit `unresolved_type` on this compiler. Destructure
  `#app.Application { names }` first to retain its checked representation.
- Retaining an ECS scope while an outer observer adds effects can leave its
  world representation unresolved. Annotate `insert_cell`'s initial value,
  builder and captured world's tuple with the same type variables so the
  compiler can infer the scope independently of the consuming call.
- `use run x` discards a callback's result whatever its type, so it does not
  check that a system returns Unit; a `case` arm of `()` beside it did. Bind the
  result and match it, `use ran <- run x` then `let () = ran`, to keep the
  check.
- `from x` inside a nested spread literal can fail with `constant_expression`;
  bind the conversion first or use `U32.to_f32`.
- Integer values sent through F32 arrays are exact only below 2^24. Use the
  guest's U32 ABI when full-width ids or seeds are needed. Physics caches keep
  ids in U32 records; a caller's F32 serialization can still truncate them.
- The allocation arena resets between guest calls. A single allocation-heavy
  call simulating hundreds of ticks can trap; advance state in bounded calls.
  `memoryBytes()` reports committed capacity, which remains allocated for reuse
  after the arena resets. See [benchmark scope and limits](benchmarks.md).
- Large generated constant caches can exhaust the compiler's constant-evaluation
  budget when several entries specialize an application. Keep discardable cache
  defaults empty and build their indices at the runtime boundary that needs them.
- The `Vec3`s, `Quat`s, other nominal records and `Maybe`s a hot path builds,
  operator temporaries such as `(a + b) * 0.5` included, are heap allocations
  unless they stay in an inlined call's locals (next note); each that crosses a
  call costs on the order of 0.1 to 0.2 µs. `std/vector` operators and helpers
  built on them, such as `math.Quat.rotate` outside loops, cost about a
  microsecond a call. The same operations on scalar fields, in the operators'
  order, round identically without the allocations: spline, steering, rig, orbit
  and director kernels gained 1.2 to 10 times that way, `ui/bubbles` rotations
  cost a fifth as much, and the scene, spatial, camera, view and gizmo paths
  work the same way.
- A record built in locals is boxed whenever it is passed to, or returned from,
  a call that is not inlined. Returned from such a call, a `Vec3`, `Quat` or
  other nominal record costs two allocations and a tuple or flat structural
  record one: `math.rotate_parts` returns a tuple, about 50 ns a call where its
  `Vec3` form took 110 to 160 ns. Outside loops only bodies of at most four
  nodes inline. Inside loops a function with a record or tuple result inlines up
  to 64 nodes, six levels deep, until the emitting function reaches 4,096
  instructions. Scalar results keep the four-node limit, so
  `vector.Vec3.dot a b` or `.length` boxes a local vector: write the arithmetic
  out or pass scalar parts. Destructured fields cost one node each, half a
  projection. Inlined locals still expand to many instructions, so large kernels
  use up the 4,096-instruction budget; keep big kernels out of line.
- An inlined result stays in locals only when every path builds a fresh record:
  a module constant such as `math.identity_quat`, or another call's result, on
  any path boxes it, so rebuild it from its fields.
- A loop-carried record whose first value was unwrapped from a variant, such as
  `let #Some timer = time.timer 1.0`, stays boxed, so every iteration allocates
  its replacement. Rebuild the first value from its fields before the loop.
- `&&` and `||` take a deferred right operand, which keeps their function from
  inlining; small kernels nest `if`s instead, which took `tween.make` from about
  0.5 µs a call to 8 ns. The same rewrite elsewhere measured no change, so
  measure before converting conditions.
- Receiver calls with arguments, such as `a.dot b` or `u.cross v`, build a bound
  closure; call `vector.Vec3.cross a b` in hot code.
- Each `record.field := value` rebuilds the whole record. Build wide records
  such as `ui/tree.Node` or `input.Input` in one constructor rather than a chain
  of updates.
- Explicit `std/simd` lanes pay where four independent lanes share the work: the
  spline arc table measures four samples per vector (23% faster), and Perlin
  noise mixes its eight corner hashes as two `U32x4`s (15%). Keeping the scalar
  operation order lane for lane keeps results bit-identical. Packing single
  values into lanes loses: one quaternion product, Perlin's gradient choice (an
  exact `% 12` per lane costs more than eight scalar calls), and frustum
  culling's six planes (2%, not kept). Lane values cross direct calls to private
  functions unboxed, yet such helpers measured about 5% slower than the same
  arithmetic inline in the spline and noise kernels. Calls through a closure box
  once per call, and a pipeline into a partial application
  (`lanes |> simd.u32_shl 13`) builds a closure each time: write
  `simd.u32_shl 13 lanes` in hot code.
- Transparent `type Name = ...` aliases work across modules. The current
  compiler packs flat scalar records/products and qualifying nested numeric
  records, including public closed single-constructor nominal records, with up
  to 16 scalar leaves. Reference-bearing fields and multiple-constructor types
  keep ordinary storage. Numeric array lanes are four bytes, and a packed row
  uses one lane per leaf. Earlier pins only packed flat structural rows.
  Packed storage does not guarantee allocation-free access: extracting a nested
  row or crossing an uninlined helper can reconstruct its boxed object graph.
  The working-set benchmarks retain a nested/flat comparison for this boundary.
- A `for` over a List of packed rows (flat tuples or structural records) retains
  about a kilobyte per traversal until the guest call returns; scalar Lists and
  Arrays of packed rows do not. Scan an Array or a flat buffer instead.
  `shapes.hull_poly` keeps its corners in a flat buffer for this reason.
- Appending or prepending boxed values one at a time to a List is quadratic:
  arrays, nominal records (even a two-field one or `Vec3`) and records holding
  them. 16,384 appends take about 14 times as long as 4,096; scalars and flat
  structural tuples stay linear. Early exits can also defeat reuse of a growing
  list in the same function; bind values before appending one item at a time. In
  hot collectors, count, then fill an exactly sized array (`scene.build`,
  `debug`). Spatial queries walk depth first with a private stack and `break`
  when it empties. Animation events use two passes to preserve F32 boundary
  behaviour and chronological ordering.
- Earlier compiler measurements found superlinear collection of reference-bearing
  elements through array comprehensions. The 2026-10-25 native audit did not
  reproduce that for `#[#[i, i + 1] | i <- indices]`: both comprehension and
  `array.generate` scaled approximately linearly through 4,096 rows, with the
  same committed memory and destroyed-object count. This does not qualify every
  filtered/capturing form. Measure the actual collector before replacing clear
  comprehensions with count/fill loops (`text.words`, `menu.sprites`).
- Rebinding array elements is cheap when a fresh local array stays inside its
  function. Passing it to a function that only reads it (lengths, indexing,
  `for`, `simd.load`, or handing it to another such reader) keeps later writes
  in place. A callee that returns, stores or captures it makes them copy, and so
  do a generic callee whose parameter is not annotated `Array T` and a callee
  containing `match`. Retained swap aliases can also defeat reuse. The sorters
  avoid excessive copying with fresh pass buffers and exact loop bounds.
- In the 2026-10-26 point-grid probe, assigning nominal `Point` records into a
  fresh array still produced `copy_required: nonexclusive_predecessor` on
  compiler SHA-256 `af349b1e6f391f7b`. Constructing each whole record directly did
  not remove it. Building scalar chain links first, then generating the record
  array once, reduced the 16,384-point construction/output fixture from 86.017
  to 8.963 ms with identical output. Ink now uses that construction. This is
  not a general rule that nominal arrays require copying. The collection review
  retains source, allocation decisions and samples for a compiler ownership
  reduction.
- `break` in an array-writing loop no longer disables reuse on the pinned
  compiler; the native compiler-probe checks keeps an intentional break control beside
  increasing writes, pathfinding and U32 sorting, with numerical checksums
  beside the timings.
- Writing one local array under both arms of an `if`/`else` or
  `if let ... else:`, whether the branch sits in a loop or each arm runs its own
  loop, loses the in-place write path: every write copies the whole array, about
  25 times the cost of an in-place write, which makes the loop quadratic. Writes
  in only one arm, or one unconditional write per iteration, stay in place.
  Choose the value in the branches and write it once after them, or choose the
  pass with loop bounds so the unused loop runs zero times (`spatial.refit`).
- Rebinding a loop-carried array to a freshly grown copy, whether inside a
  branch or once per outer pass, makes every later indexed write in the loop
  copy the whole array (navigation's heap stays allocated at its full size).
- A closure literal passed straight to `@array.generate`, or to a reading
  parameter such as `std/array.map`, borrows the arrays it only reads, so later
  writes stay in place. A closure bound to a local first (`let f = fn ...`), or
  one that stays alive, makes every later in-place write copy the captured
  array, which turns a write loop quadratic: pass the literal.
- Curried calls can capture mutable array lookups and make later writes copy
  storage. Bind lookup results to scalar locals before passing them to calls or
  compound comparisons; this removed two hot memory copies from pathfinding.
- A copy made with `@array.slice` is not known to be fresh: later writes copy it
  again each time (a 65536-element write loop went from 0.3 ms to 366 ms).
  `arrays.copy` uses `@array.generate` for that reason.
- Returning a data value such as `#Nothing` from inside a `for` loop that also
  rebinds a carried local slows every iteration about four times, even when the
  return never fires (a scalar return or no carried local stays fast). Set a
  flag, `break`, and return after the loop, as `navigation.grid` does.
- Reading an ECS column with `values.get(index)` inside an `array.generate`
  callback made reads scale with the column: cycle-collector work grew about
  twentyfold per doubling. A bounds check and `values[index]` fixed it. Small
  fixtures outside the ECS's nested effect scopes stay linear, so measure.
- Trial-deletion cycle collection can visit a large graph reachable from its
  candidates. Historical pins used a fixed 64 KiB traffic threshold; the local
  Blot source reviewed on 2026-10-25 has an adaptive threshold and exact
  immutable-acyclic proofs that skip collection. Source capabilities do not
  establish which paths the installed binary optimizes. Copying shared reference
  arrays can still amplify both reference-count and collector work. The guest's
  `blot:rc_*` and `blot:cycle_*` counters distinguish these costs.

The [2026-10-25 audit](../tools/audits/2026-10-25-whole-library.json) records
compiler hashes and executable probes for these compiler-dependent notes;
historical timing ratios and inline-budget details above are not language
contracts. With 4,096 scalar writes, a slice-then-write loop took 0.829 ms versus
0.020 ms for generate-then-write, and writes in both conditional arms took
0.793 ms versus 0.010 ms for one write of a conditional value. Their counters
show thousands of destroyed objects versus single digits, with no cycle passes.
These are ownership/freshness optimization gaps, not SIMD or collector costs.
Separately, the complete profile-packet decoder showed quadratic reference-count
traffic. Validating/indexing first and constructing reference-bearing rows
afterward reduced 2,048-node decoding from 41.744 ms to 0.667 ms. The prototype
preserves complete-packet validation in differential tests; partial-tail recovery
is a separate contract. Early-failure control flow is a compiler investigation
candidate, not a proven explanation of every allocation in that decoder.

The follow-up [ownership patch](../tools/experiments/blot-owned-arrays.patch)
teaches Blot that exact-array slice/concat results have fresh outer storage and
that two writes in provably disjoint branches consume one dynamic array
version. Lists, escaping aliases and retained predecessors keep the conservative
path. Native ownership tests, allocation-failure sweeps and executed-Wasm
snapshot regressions pass. The slice and branch probes become linear without
rewriting the caller. This is a development patch in `../blot2`, not an installed
compiler guarantee: full release qualification remains pending. Safe builds of
the unmodified parent revision also hit an entry-interface assertion on Ink's
codec fixture; Ink's full suite passes with the installed compiler. Exact
compiler identities and measurements are recorded in the
[implementation report](../tools/audits/2026-10-25-library-improvements.json).

`render.layer draw presentation frame` composes a complete UI layer over the
existing sprites and model previews. Each inset carries `after_sprites`, the
number of sprites beneath it; equal boundaries keep inset order. Use layers for
modals so their backgrounds cover HUD text while their own text remains above
their 3D icons. `render.seen` defaults to the current sprite boundary.

`render.emit draws frame` and `emit_many groups frame` collect complete draw
chunks without copying earlier world draws. `frame.draws` remains the pending
tail. Call `render.finish` before inspecting or replacing the entire draw list;
it concatenates chunks and tail in order and clears the chunks. Replacing a
scene with `render.empty` also drops its old chunks. The Pen adapter finishes
pending chunks before encoding.

The default `draw_meshes` / `draw_meshes_where` systems read immutable ECS views
and append a chunk. Collection preserves entity order and tests visibility once
per entity with both components, before interpolation and matrix construction.
New entities without a previous pose use their current pose. The standalone
`draw_columns_using` requires previous/appearance arrays at least as long as the
current array; `draw_views_indexed` uses each view's own bounds and alive bits.

Pen's generated `encode_render_draws` accepts typed scalar projections for a
caller's draw representation. The Ink adapter supplies mesh/material ids,
sixteen transform lanes, optional parameter lanes and bounded extra lanes,
without copying matrices and vectors into nominal wire records. Other packet
sections retain their normal wire types.

## Retained draw matrices

`ink/render/cache.update current previous appearances alpha dirty cached` takes
immutable ECS views and explicit dirty entity slots. Start with `cache.empty`.
Include removals, appearance edits, reused slots, and every interpolating slot
when alpha changes. Appended slots refresh automatically; shrinking truncates
the cache. World replacement/restore starts cold. Dirty duplicates are harmless
and out-of-range indices are ignored. Earlier caches remain valid snapshots.

`update_changes` accepts `changes.Changes` in place of the dirty array. Explicit
removals clear slots; reset discards the previous cache. Sparse edits copy
touched 64-slot pages and bounded radix paths. Cold or dense updates use flat storage
to keep matrix construction efficient. `cache.read cached index` reads a valid
slot.

`collect visible cached` returns draws in entity order. Its predicate receives
the entity slot and final Draw, so a camera change can alter visibility without
rebuilding matrices. `cache.all` accepts every draw; `emit` appends a chunk to a
render frame. Collection still visits all slots; matrix construction only visits
refreshed slots.

`ink/changes.make reset updated removed` sorts and deduplicates indices, with
removal winning within a batch. `compose earlier later` applies the later batch
last; a later reset replaces earlier changes. `affected` returns the union.
`union` and `difference` accept sorted unique arrays and merge in linear time;
`difference` uses binary searches for a tiny left side against a much larger
exclusion set. `without` retains arbitrary source order with sorted exclusions.
`make`, `compose` and `affected` normalize their inputs before these operations;
`apply` expects the retained key set to be sorted and unique.
`scene.update_changes` consumes the same indices, with source values determining
collider removal. Reset rebuilds the scene.

`ink/pages.from values` creates immutable 64-slot pages in a 64-way radix
directory. Small collections are a single leaf. A single edit copies at most six
bounded arrays; old roots and untouched subtrees remain shared.
`update count dirty value_at before` replaces touched slots and newly appended
slots, truncates on shrink and keeps earlier snapshots usable. The callback
receives a slot index exactly once per changed or newly appended slot. Dirty
indices may be unordered or repeated; out-of-range indices are ignored. Each
copied page uses its own normalized dirty range, without a membership search for
every copied slot. `get` requires an in-range index; `flatten` materializes the
current values.

Ordinary physics steps reuse the supplied scene's BVH for active/resting pairs
when at least 64 non-trigger proxies are resting. Keep the scene current through
`scene.update` with explicit dirty source indices. Walker and CCD adjustments
refit their changed proxies in a temporary index; the same index serves a second
pass after wake propagation. The active/active sweep and small resting-set sweep
remain available. No additional persistent physics cache is required. The
low-level `physics.broad_phase_indexed` requires an index matching the supplied
proxy bounds; ordinary callers should use simulation's scene integration.

## Prepared static physics

`ink/physics/prepared.prepare fixed_sources` validates and builds an immutable
static scene and U32 ID index. `simulate fixed config dt moving_sources cache`
queries that BVH for nearby geometry, includes cached support contacts and
passes a compact work set to the existing solver. `simulate_joints` adds a joint
array before config. Results address the moving source array, and contact IDs
retain all 32 bits. Callers own the moving bodies, contact cache and step.

Rebuild when fixed geometry changes. Older prepared worlds remain usable. Fixed
sources must have no walker and no dynamic/kinematic body; terrain retains its
finite, world-space contract. The fast path preserves source order and uses a
conservative travel envelope for CCD. Walkers query the moving and static scenes
independently; their controller pass selects the contact neighborhood and its
results are reused by the compact solver. `physics.move_walkers`,
`extend_walkers` and `simulate_walked` expose the same mechanism for composition:
the pass must use the same timestep and query snapshot, and only unchanged fixed
proxies may be appended before simulation. Joint endpoints address
`[moving..., fixed...]`; required fixed
anchors are included even when they have no collider. These cases no longer
rebuild the full static scene each step.

`scene.queries scene` wraps an existing index, and `together first second`
composes query sets. `query_cast`, `query_ray`, `query_overlap_sphere`,
`query_overlap_capsule` and `query_point_solid` retain part order for ties and
overlaps. Hit proxy indices address the concatenated proxy arrays. Callers keep
IDs unique across parts. `character.move_queries` accepts this composed view;
`character.move` remains the single-scene convenience function.

## Pen retained-instance experiment

`ink/pen/instances.attach reset updates removals packet` returns `Maybe` a Pen
wire frame. Each `Update` contains caller-owned U32 `id`, ordering key `order`
and a Draw. IDs travel as two exact 16-bit lanes; `order` is at most 16777215.
This path supports unskinned draws with optional parameters and no extra vec4s.
It rejects unsupported extras and oversized updates. Hosts reject duplicate IDs
within a packet, including an ID both removed and upserted. Removing a missing
ID is idempotent. Retained draws follow immediate draws, sorted by `(order,id)`.

Construct a wire frame with `pen/host.wire_frame`, attach instance changes, then
use Pen's generated encoder (or `encode_render_draws` for accompanying immediate
draws). `wire_frame` leaves its immediate draw array empty for scalar
projection. The normal `host.encode_frame` continues to use immediate draws.
Applications explicitly choose this path and own IDs, dirty sets and reset
policy. A fresh host, create, restore or reload requires a full reset; disabled
frames clear the host cache. Never carry a delta-only cache through a world
replacement.

The matching schema and transactional host implementation are preserved in
`tools/experiments/pen-retained-instances.patch`, against the recorded isolated
Pen working-tree snapshot. See `tools/experiments/pen-retained-instances.md` for
validation and integration details. CPU assembly reuses the accepted draw order
and patches dirty slots. Host-only revision identities carry those changes into
GPU upload planning, with value comparison when frames are skipped or placements
change. The host still copies the complete draw view and performs culling.

## Semantic observations

`ink/pen/semantic` is an optional Pen adapter. Applications build a descriptor
with `field`, `variant`, `described` and `schema`, then publish selected
`object` values and explicit `decision` events through `observation`. Identities
contain exact U32 words; `encoded` preserves domain words, including
`codec.float_word` vectors. JSON text is ASCII with Unicode escapes, carried as
one byte per F32 lane. `capture_request` constructs the host's capture-selection
request.

An observation is a `render.Extension`: append it to `frame.extensions` in an
application render system. The Pen host encodes those publications after the
render packet. Other hosts may interpret or ignore application tags. Empty
extensions add no packet bytes and require no snapshot or whole-world scan. The
application owns selection, schema IDs, labels, decisions, truncation counts and
transient event storage. A changed selection scope must change the schema ID.
Pen stores these observations separately from simulation history, sharing
repeated descriptors and unchanged objects. Publishers must not change gameplay
state; transient trace queues can be drained after presentation.

The opt-in `services/typed` adapter passes its isolated Wasm tests, but gdev's
larger hand fixtures currently fail with compiler `InvalidArtifact` when Reports
contains its `Method` records with encode/decode functions. Removing individual
calls or making the records factories did not fix those builds; removing the
method definitions and retaining direct service calls did. Keep direct calls at
that boundary until the compiler issue is reduced and fixed. This is an observed
compiler limitation, not a requirement that service definitions be effectful.

The bounded navigation lookahead experiment also encounters `InvalidArtifact`
when a spawned child returns `Maybe Forecast`, a record containing a path array.
The same pure forecast compiles and executes outside a task. Serializing its
result to an explicit `Array F32` inside the child compiles, runs in both hosts
and matches every path point. Keep this transport limitation separate from the
purity of the underlying calculation; generic structured task results still need
compiler qualification.

Passing an immutable numeric array into a helper before opening its task scope
allows shared captures in the bounded batch/path trial. Capturing the equivalent
locally generated array directly reports `task_capture_transfer`. Capturing a
`navigation/ground.Ground` record reports `capability_escape`; sending a
validated numeric `navigation/packet` and rebuilding its index inside the child
works. These are qualified workarounds for the current compiler, not language
rules.

`navigation/packet.decode` accepts version 1 packets with at most 1,024 total
obstacles and finite coordinates/radii bounded by 1,000,000. It rejects invalid
rectangles, negative circle radii, fractional counts and trailing words.
`encode` expects the caller's ground to fit those transport bounds; it does not
clamp geometry or weaken the decoder. `navigation/lookahead` bounds each
forecast to eight waypoints and 128 steps of at most one second. The caller must
revalidate world and actor revisions before using a forecast computed from an
old snapshot.

`radial.row` uses explicit `U32.to_f32` for grid coordinates. Replacing those
conversions with overloaded `from` in the parameterized Grid helper produced
`constant_expression` on the pinned compiler, including in a small standalone
fixture. The explicit conversions compile and preserve every sample.

Opaque wrappers in the live gdev Resident/Pilot controller graph fail with
`InvalidArtifact` on compiler `4188037e` and the qualified `957ec6df` candidate.
The same graph compiles with distinct `type ActorId is data = #ActorId U32` and
`HomeId` declarations; the rejection fixture still prevents mixing these types.
Use nominal tagged IDs at this boundary until opaque lowering is repaired.

The same opaque-lowering failure affects `services/typed.Pending output` when
its methods enter a larger application graph. A distinct tagged `Pending`
retains the answer type and method checks and allows the live reporting service
to compile. It is a typed request identity, not a one-shot linear capability;
consumption is enforced by the Services inbox.

### Qualification notes for the installed compiler

- `use` binds an identifier. Bind a tuple result to a name and destructure it
  with `let`; `use (a, b) <- action` is rejected by the source grammar.
- A read in a loop's eligibility condition can prevent reuse of the array
  updated by the loop. In `rigid.restitution_pass`, the contact activity flag
  never changes in that pass: reading it from `imp_in`, rather than `imp`,
  removes the compiler's `copy_required: escaped` site. Keep the sequential
  velocity and impulse updates; bulk mapping would change the solver.
- SIMD stores can avoid scalar ownership hazards, but compiler and caller
  context affect the result. Compare against the current scalar implementation
  in native Wasmtime, preserve operation order, and test full output bits.
- In the worker packet fixture, nested `array.generate` with
  `from (job * 64 + lane)` failed native emission with `constant_expression`.
  The explicit `U32.to_f32` conversion compiles and preserves the values.
- A partially applied polymorphic host wrapper
  (`const frame = frame_using
  encode_frame`) failed with `unresolved_type` in
  the game's devtools fixture. An explicit function forwarding all four
  arguments compiles that fixture; retain the wrapper instead of replacing it
  with the partial application.

## Presentation layers and dialog lifetimes

`app.in_layer order plugin` assigns the render systems added by a plugin to a
caller-owned numeric layer. Lower numbers draw first; ties retain registration
order. Plain `Render` uses layer 0. Sorting happens at application build time,
including diagnostic labels. Update, event and resource registration order stay
unchanged. `run_if` and `render_if` preserve these layers. Use `render.layer` to
compose a panel's sprites and 3D insets at the same painter position; a renderer
that intentionally replaces the scene must keep control of its complete frame.

`input.plugin` registers one Interface handler. Install it before consumers: it
updates the current pointer/keys and resets the event's claim once. Claims made
by Interface systems survive into Event systems; the next event resets them.
Paused worlds still receive Interface input, but skip Event and Update systems.
Handlers that own an action call `input.claim`; later action handlers must check
`input.claimed`. A claim does not stop service notifications or renderer events.

`ui/dialog.respond policy rect secondary_held event` returns `Pass`, `Handle` or
`Dismiss`. The `dialog` and `popover` policies dismiss on outside primary press
or Escape and allow secondary camera gestures. The `modal` policy owns pointer
and keyboard input and dismisses on Escape, not outside click. Applications
perform close actions and claim consumed input. `pointer_inside` uses the same
bounds to prevent clicks reaching a background control covered by a panel. These
policies describe interaction; the caller supplies drawing and pauses its
simulation when appropriate.

Declare a dialog root with `ui.dialog_node` and parent its controls to that
root. A modal root confines keyboard focus and makes other nodes inert: they
become hidden to assistive technology and their semantic actions are rejected.
Hidden ancestors also hide descendants; disabled controls remain discoverable
but unavailable. `ui.inert_when` marks a semantic subtree inert without changing
its visuals; callers must gate its raw pointer/world actions by the same state.

`ui.enter_dialog root first_control` remembers the opener and focuses a control;
`ui.leave_dialog root` restores it. Declare the root and initial control on the
first open frame, even while an opening animation runs. Re-entering a root does
not overwrite its opener. Nested modal lifetimes preserve the underlying dialog.
Settlement drops absent top roots and validates the restored focus; a missing
background root remains recorded while a modal covers it. Escape reaches the
owner of an open scope even after keyboard focus moves outside a nonmodal panel.
Focus codec key 15 version 2 saves return scopes and migrates version 1 to an
empty stack.

In the layer-order fixture, projecting `application.labels.renders` directly
from a generic Application produced `unresolved_type` on compiler `faf3f78`.
Destructuring `#app.Application { labels }` before reading `labels.renders`
compiled and retained the same diagnostic-order witness.

## Fields, histories and headless presentation

`field.grid width height tile_width tile_height` describes a rectangular sample
field. Dimensions must be positive and the tile count must fit U32. Regions use
half-open sample coordinates (`left`, `top`, `right`, `bottom`); they clip to
the field and reversed/empty regions select nothing. `affected` combines region
masks; `changed_rows` compares explicitly selected rows and returns a tile mask.
Missing rows are zero; present selected rows must have exactly `width` cells.
Unselected rows are not inspected. Numerical comparison treats signed zero as
equal; callers supply finite field values. Values, field evolution, coordinate
mapping and border choices remain application-owned; `field/sample` supplies
optional numerical sampling kernels.

`field.revise mask revision tiles` advances the current world's revision and
only replaces touched tile tokens. An empty mask preserves the revision.
`unchanged grid region before after` tests a sampling footprint without scanning
the field values. Keep revisions with the world, and advance them even when
replacing data with an older snapshot. This composes with `derived/keyed` rather
than introducing another cache lifetime.

`history.empty capacity` creates a bounded chronological buffer. `push`, `get`,
`drop` and `values` operate in oldest-first order; zero capacity retains
nothing. Physical slots are an implementation detail. Updating the returned
buffer preserves earlier snapshots. Do not manufacture buffer fields yourself.
`sample now value buffer` stores a finite, nondecreasing timestamp, including
repeated timestamps. `expire cutoff` removes entries strictly before the cutoff;
remaining entries keep their timestamps. It visits expired entries rather than
rebuilding every surviving sample's age. `shift delta` changes the clock origin
explicitly, copying retained samples once. Callers choose retention limits,
sampling cadence and a time origin that preserves the required F32 precision.
Reset a buffer when replacing its timeline.

`statistics.counters_reset before after` detects a counter decrease or changed
channel count. `counter_rates elapsed before after` returns no result for a
reset or a nonpositive/nonfinite interval; it subtracts full-width U32 counters
before converting differences to F32. Counter wrap is treated as a reset.
Smoothing and minimum observation intervals belong to callers.
`quantile fraction values` uses the nearest-rank convention, with 0 and 1
selecting min and max. Empty samples, nonfinite values and fractions outside [0,
1] have no result. `largest count values` selects finite samples in descending
order; zero count returns an empty array.

`ui/anchor.attach side alignment gap size anchor` creates an above, below, left
or right placement, with alignment clamped to [0, 1]. `fit bounds panel`
translates a panel inside the supplied bounds; oversized content keeps its size
and aligns to the low edge for caller-controlled clipping or scrolling.
`place bounds
candidates` selects the first candidate that fits, otherwise the
least overflow, with input order breaking ties, then fits it. Empty candidates
have no placement. Inputs are finite and dimensions nonnegative. Safe areas,
preferred sides, scaling and HUD exclusions are caller policy.

`ui/outline.rounded rect radius` describes a clockwise rounded rectangle
starting at its top-left horizontal tangent. Radius clamps to half the smaller
dimension; negative radius becomes zero. `length`, `point distance` and
`distance point` provide arc-length geometry, independent of any drawing or
animation. Point queries wrap finite distances; inverse queries expect a point
on the outline. The seam can have distance zero or the full length. Zero radius
has square corners, and a rectangle with zero width and height is a point.
Finite, nonnegative rectangle dimensions are required; use dimensions whose
perimeter is representable in F32. Materials, connector choices and easing
remain outside this module.

`ui/console` supplies catalog completion and command-history navigation without
an event loop or command executor. `Entry.argument` explicitly says whether a
command needs an argument, including free-form arguments without choices.
`sorted` preserves equal-name order. `named` and `valued` receive an explicit
prefix, separator and catalog. The caller tokenizes input and supplies labels,
argument choices and readiness policy. `recall` retains the current draft while
browsing an oldest-first history; `remember` applies caller limits, truncates
long lines and removes adjacent duplicates. Ordinary arrays can keep an existing
application save layout.

`locale.Cache` holds pending request IDs and separate displayed and spoken text.
`grow` appends empty slots without losing previous answers; `begin` requires a
declared slot and a nonzero full-width ID. `resolve` only accepts the current ID
for that slot, ignoring stale or duplicate replies. Failed replies finish the
request and retain prior text. `word` falls back when displayed text is empty;
`spoken` falls back to displayed text, then the caller's fallback. Column lookup
helpers allow an existing saved representation to avoid per-lookup wrappers.
Callers own keys, language changes, retry policy and codecs.

The optional `pen/locale` adapter issues locale requests and decodes Pen's zero
separator between displayed and reading-order text. With no separator both use
the same text. Plural counts use Pen's existing numeric argument; exact counts
above F32's integer range need a future host protocol extension. Text shaping
and plural rules stay in the host. Core localization has no Pen dependency.

The [sensor-dashboard example](../examples/mechanisms.blot) composes all six
mechanisms without a game or host. In benchmark/FFI entries that only build
arrays from polymorphic `from` conversions, annotate `-> Array F32`; otherwise
the installed compiler can emit `unresolved_type` because no caller fixes the
numeric result representation.

## Keyed collections, trajectories, sampling and inspection

`reconcile.match_keys before after` returns `Maybe Plan` for arrays of unique
full-width U32 keys. Duplicate keys in either input are rejected. `previous`
follows the new array's order and contains old indices; `before_count` is its
absent sentinel. `added` contains new indices and `removed` contains old indices,
each in its own input order. Empty collections are supported. Sorting and merging
replace repeated scans without changing the caller's ordering or values.
`build plan retained added` produces new values, calling exactly one callback per
new index: `retained old_index new_index`, or `added new_index`. The caller owns
the old values, initialization, transitions and disposal of removed values.

`trajectory.prepare gravity from to rise` returns a ballistic path with prepared
launch speed and duration. Gravity must be positive, rise nonnegative, and the
destination no higher than the apex. Inputs and computed coefficients must be
finite; zero-duration paths are rejected. `position path seconds` evaluates the
path without clamping time. Horizontal motion follows the endpoint chord and
vertical motion uses constant gravity along -Y. Callers choose time clamping,
landing policy and lifetime. `arch from to rise fraction` instead describes an
authored parabola above a straight chord, with maximum offset at fraction 0.5.

The scalar `launch_speed`, `flight_time`, `rise_for_time`, `height` and
`position_using` kernels avoid constructing a path when the caller already owns
its coefficients. They require finite inputs and representable results, positive
gravity/duration, and nonnegative rise. `flight_time` clips a requested height
above the apex to the apex; `prepare` rejects that unreachable path.
`rise_for_time` returns zero if the requested duration requires no upward launch.
`traverse sample start finish segments contact` samples consecutive chords and
returns the first callback result. Segments must be nonzero. Reverse and
zero-length traversal are supported; the contact callback receives both endpoints
even for a stationary chord. Subdivision, tolerance and initial-overlap handling
are explicit caller choices. Chords approximate a curve; they do not guarantee
exact continuous collision against it.

`field/sample.mapping width height x y dx dy` validates a rectangular grid of
sample centres. Dimensions are positive and at most 2^24; origins are finite and
spacings positive and finite. `cubic mapping border accessor x y` returns a
uniform cubic B-spline filtered value, or `Nothing` for nonfinite transformed
coordinates. The accessor receives column then row and is called only in bounds.
`Clamp` clamps the sample coordinate and repeats border samples; `Zero` includes
zero for missing neighbours. B-spline filtering smooths values and generally does
not reproduce individual samples at integer coordinates.

`cubic_rows wx wy row` evaluates a 4x4 stencil in row-major F32 addition order.
Each weight array has exactly four lanes; `row b` supplies a column accessor.
For hot callers holding their samples in locals, `accumulate4 sum wx wy a b c d`
adds one row directly without per-cell callbacks. It requires four X weights.
Both forms preserve sequential multiplication/addition order. This lets callers
combine several fields without constructing a temporary grid. Mapping, clipping
and sample composition can also be performed explicitly by those callers.

`profile.Node` carries function ID, depth, span offset, inclusive and self sample
counts, and caller-provided name codepoints. `hottest nodes most` sums **self**
samples, preserving addition order within each function. Results descend by
total, with first-observation order breaking ties; names come from that first
observation. IDs remain full-width U32. Negative/nonfinite self samples and
overflowing sums trap. Zero totals are omitted. `trunk nodes total fraction`
finds consecutive depths whose widest span reaches the supplied fraction of
total; missing depths end the trunk. Its storage is bounded by node count, not
depth IDs. Invalid totals/fractions return zero.

`profile.layout bounds row_height skipped total nodes` returns node indices and
raw rectangles in input order. Rectangles clip to the supplied bounds, including
partial last rows. Nonpositive totals/row heights or empty bounds yield no
rectangles; nonfinite geometry traps. Callers provide gutters, minimum displayed
widths, labels, colors, input and selection. Layout has no rendering side effects.

Optional `pen/profile.flame` and `memory` validate whole Pen inspector responses,
including lengths, numeric domains and Unicode scalar values. They return
`Nothing` for malformed/truncated packets. `flame_prefix` and `memory_prefix`
explicitly permit an incomplete last node/counter and retain complete preceding
records; the flame hot-list must still be complete. Complete malformed records
are rejected in either mode. Memory counters combine Pen's high/low base-2^24
lanes into approximate F32 display values. This adapter cannot recover integer
precision already lost by the host's F32 wire format. Request scheduling and
recovery/display policy belong to callers.

`render/lod.projected pixel_height focal_y near depth extent padding` computes
perspective extent in actual output pixels at `max near (depth - padding)`.
Inputs/results must be finite; near/focal are positive and output size, extent
and padding nonnegative. Frustum culling is separate. `levels thresholds`
validates strictly increasing finite nonnegative pixel thresholds, ordered from
coarse to fine. `select levels pixels` returns an index in 0..threshold_count;
equality selects the coarser level. Pixels must be finite and nonnegative.
`stable levels pixels band previous` adds absolute pixel hysteresis on either
side of each threshold, crossing multiple levels on large changes. A previous
index outside the level range selects afresh; zero band equals `select`.
Applications own thresholds, meshes, quality settings and previous selections.

The native parser does not accept tuple destructuring in a function parameter
(`fn (a, b) => ...`). Bind one parameter and destructure with `let (a, b)` in
its body. The diagnostic may point to the enclosing declaration rather than the
parameter pattern.

## Sparse working sets and prepared workers

`changes.apply delta sorted_keys` applies an explicit membership change to a
sorted, unique U32 key array. Updates add/wake keys, removals remove/sleep them,
removal wins within one batch, and reset discards the previous membership.
Results are sorted and unique; all U32 keys are valid. Old arrays remain usable.
The application owns activation rules and must report every relevant mutation.

`ecs.update_selected constructor ids step`, `update_pair_selected a b ids step`
and `update_triple_selected a b c ids step` call the pure step once per selected
live entity containing all requested components. The callback receives the
entity index first, followed by component values, and returns replacements.
Unordered/duplicate IDs are normalized; dead, missing and out-of-range slots are
ignored. Callbacks run in ascending entity order. Empty selections preserve
column revisions. Nonempty selections advance each written column once, retain
membership, and copy only touched leaves/blocks plus their top-level tables.
Old worlds, read views and checkpoints retain their previous values.

`field/buckets.build grid regions` clips half-open sample regions and produces
an immutable prefix table `offsets`, source `indices`, and ascending `occupied`
tile IDs. Tile `i` uses `indices[offsets[i]..offsets[i+1]]`, in original region
order. Empty/reversed regions select nothing. `region grid tile` returns a
clipped tile footprint. Callers evaluate their own kernels only in intersecting
spans, preserving source order when floating-point accumulation requires it.

`render/retained.update_keyed order draws delta before` uses arbitrary U32 group
keys and separately allocated instance IDs. Start with `keyed_empty`. Reset
updates describe the complete scene; other updates/removals describe only
changed groups. `draws key` runs once per updated key; `order key slot` runs once
per emitted draw. Unchanged groups are never requested. Membership changes
rebuild the key table; ordinary edits copy touched identity pages. Keep the
returned stream with the same world that produced its delta. A rejected frame
must retry from its prior world/stream. Pen ordering keys still fit 24 bits;
group and instance identities retain their full U32 range.

`pen/worker_session.serve prepare plan host` implements an optional native
service entry. The host configures numeric context, then submits numeric jobs.
`prepare` runs when that worker's context changes; `plan prepared input` receives
immutable prepared values explicitly. Context, input and output are finite F32
arrays of at most 16384 lanes. Pen's `blot_host::worker_sessions::Workers`
admits 1–8 workers and at most 32 jobs per batch, with results in submission
order. Reusing the currently configured revision requires bit-identical context,
including signed zeros. A different revision installs a new context; old revision
numbers are not remembered. `reset` clears the configured context and forces
preparation on the next configured batch. Workers retain their old data until
that next preparation or `close`. A failed job discards its guest; subsequent
jobs recreate and prepare it. Prepared data and transport remain outside saved
simulation state. The optional adapter requires a host that supplies this pool;
it does not create threads from Blot or automatically parallelize ECS systems.

The client uses `worker_session.configure host revision context` when context
changes, `run host jobs` for successive batches, and `reset host` at an explicit
boundary. Empty batches make no host call. The callback is
`Array F32 -> Array F32 ! { Foreign }`; a native host forwards it to `Workers::call`.
A failed job rejects the whole client callback result, so callers cannot publish
a partial wave. Direct Rust `run_prepared` instead returns one Result per job.
Pool `close` joins workers; dropping a pool closes it. Guests are isolated,
limited to 64 MiB each, and run caller-selected trusted service code. This API
has no per-job timeout; closing waits for currently executing guest code.

`schedule.execute_with plan initial dispatch commit` validates the complete plan
before invoking any dispatcher. `dispatch snapshot wave` may call a host; it
returns one delta per source index in that wave's sorted order. Result count is
checked before pure `commit state index delta` runs in source order. No live ECS
world is shared between workers. `schedule.execute` uses the same mechanism with
a pure serial dispatcher. Access declarations still belong to the application.

For a retained plan, call `schedule.prepare plan` once to obtain `Maybe Prepared`.
It validates the plan and retains normalized waves. Use
`execute_prepared_with prepared initial dispatch commit` or the pure
`execute_prepared prepared initial run commit` for repeated runs; these return
the resulting state directly and still check each dispatched result count before
committing that wave. Construct preparations through `prepare` and replace them
when the plan or its access declarations change. Old preparations remain valid
for their original plan. The ordinary executors continue to validate on every
call and return `Maybe state`.

`partition.ranges count maximum minimum` creates balanced nonempty jobs, capped
by maximum, with at least minimum elements unless the entire input is smaller.
Zero count produces no ranges; zero limits trap. Coarsen work before dispatch:
threading tiny jobs can cost more than their calculation.

The client protocol starts with -4670547: command 0 resets; command 1 carries
revision low/high 16-bit halves, context length, then context; command 2 carries
the existing -4670545 worker batch packet. Reset/configure acknowledgements are
`[-4670547, command]`. Job responses use the existing batch framing. The service
protocol remains -4670546, with prepare/job/stop commands 1/2/0. All framing and
numeric limits are validated before dispatch. See `tests/fixtures/simd_workers.blot`
for an actual effectful scheduler/client round trip.

## Prepared SIMD columns

`motion/springs.prepare frequency damping dt` returns Maybe Prepared. Inputs
must be finite and nonnegative, frequency × dt at most 8192; unrepresentable or
degenerate derived coefficients return Nothing. Frequency is angular rad/s.
`step prepared spring target` reuses those coefficients for one spring;
`columns prepared values velocities targets` returns new position and velocity
columns, preserving the inputs as snapshots. Column lengths must match.
`step4` is the lower-level four-lane kernel. Keep columns between frames and
reprepare only when rates or dt change. Hot inputs and arithmetic intermediates
must be finite with representable results, as for the scalar spring kernels.
All damping regimes preserve scalar operation order; no FMA/reassociation is
used. dt zero returns the original columns.

`render/bounds.spheres x y z radius` validates equal-length finite columns and
nonnegative radii once. `classify sight pixel_height spheres` returns numeric
0/1 visibility and full projected diameters, including for culled spheres.
Retain these columns between calls. Each SIMD lane represents an independent
object; dot products and comparisons follow scalar `render.sees`. Projection
uses `render/lod.projected`'s contract: positive near/focal, nonnegative output
height, finite inputs and representable results. Incomplete groups use scalar
kernels. Results preserve input order; selection and LOD policy remain separate.

`field.changed_rows` now compares four adjacent samples at once, preserving
explicit dirty rows, implicit-zero missing rows and early exit per changed tile.
NaNs count as changed; signed zeros compare equal. `codec.pack` uses four-word
loads and interleaved low/high 16-bit halves; header, validation, exact padding
and full-width U32 identities are unchanged. These two improvements require no
caller changes.


`lookup.build keys` indexes full-width U32 keys without changing source order;
`lookup.find index key` returns the first source index for duplicate keys.
`spatial/point_grid` maintains append-only floor-plane points in paged hash
chains. `build cell_size bucket_hint positions`, `push position grid`, and
`within grid x z radius` preserve old snapshots. Queries return exact radius
matches once each, in unspecified order; resolve ties using source indices.
Construction records scalar bucket links first and creates each point row once;
it preserves source indices and the original collision-chain order.
`pages.set index value pages` and `pages.push value pages` copy one leaf and its
bounded radix path. Prefer `pages.update` for batches of known edits.
`ecs.indices view` enumerates live component IDs directly from occupied words.
`ecs.insert_selected constructor sorted_ids values` inserts/replaces sparse
components, copying touched leaves once; IDs must be sorted, unique and live.
It preserves unrelated components and previous snapshots.

An empty spatial index computed with `points.build #[]` inside a global game
plugin default caused `constant_expression` at prelude `from` on compiler
`8879d69`. Keep that discardable default as an explicit cold record and build
its index when data arrives, instead of evaluating the builder at compile time.


`ecs.write_observed changed value` writes an observed resource using the caller's
semantic change witness. It updates the world-owned revision without comparing
its old and new values. The caller must supply `changed` for that resource's
registered equality relation. Ordinary `ecs.set` retains the checked path.
`ecs.insert_observed_resource_using prepare equal initial` (also in `app`, with
a codec) prepares arbitrary replacement writes as `prepare old incoming` before
comparing and storing them. Use this to rebuild discardable indices after a raw
replacement or restore; known writes preserve prepared storage and snapshots.
Initialization keeps the supplied value, so an initial cache may be explicitly
cold. These helpers add no saved lanes.

On compiler binary SHA-256 `6b9ed919a48f`, a replacement callback with unconstrained type in an
observed resource handler compiled alone but failed `constant_expression` when
specialized into the full game. Giving `prepare`, `equal` and the initial value
explicit shared resource types fixed it. No compiler change was needed. A fresh
`array.generate` output also matters in dirty-slot loops: writing repeatedly to
an alias of a resource array caused a full copy per selected slot in measurements.

## Incremental ECS composition

`ecs/query.Filter` supports `With key`, `Without key`, `Optional key`, `All terms`
and `Any terms`, including nesting. Empty All matches every live entity; empty
Any matches none. Keys are caller-assigned U32 component names. Bind each key
once using `query.source key constructor`; missing or duplicate bindings trap.
Keep that key-to-component assignment fixed for the cache lifetime.
`query.prepare epoch filter sources cache` returns ascending live entity indices.
Its key contains the filter, bound structural revisions and entity revision.
Payload writes and optional-component changes keep membership cached. Obtain
fresh sources on every prepare; sources are snapshots, not subscriptions.
`query.select` resolves without retaining a cache. `query.each selection action`
visits the captured indices in order under entity scope. Capture typed
`ecs.view`s for value reads, including optional values, and evaluate value
predicates on each invocation. Membership caching does not cache payloads.
`ecs.indices` visits set bits in sparse membership words and scans dense words
directly. Sparse selected writes retain unchanged masks and occupied-word lists;
membership transitions merge only affected word indices. A dense batch uses a
direct mask rebuild. Structural edits to the remaining flat mask array still
copy that array once, and older views keep their original metadata.

Keep the cache with the world lineage that produced it. The caller's epoch must
change on world replacement, and caches/readers must start cold when moving to
an independently modified fork. Revision counters trap before wrapping. Old
views, worlds and caches remain valid for their original snapshots.

`ecs.register_tracked_component epoch capacity exemplar builder` and
`register_tracked_snapshotted_component` opt a component into a bounded journal.
The matching `app` registrations also take a component codec after capacity;
only component values are saved. `ecs.component_cursor constructor` starts a
reader at the current end. `component_changes reader constructor` returns
`Delta {changes, cursor}` or `Reset cursor`. Adopt the returned cursor only when
the consumer has applied the delta or rebuilt from a fresh view. Independent
readers do not consume each other's changes. `restart_component_journal epoch
constructor` starts a fresh tracking timeline without changing components. Ordinary writes conservatively
count as changes even when values compare equal. Known selected writes report
only touched IDs; insertions/removals update structural revisions separately.
Selected mutation batches fill a bounded event array once, then publish to the
journal. They do not repeatedly append and copy an expanding event array.
Whole-column replacements (including dense update and restore), lost retention,
and any entity spawn/despawn request Reset. Despawn now clears current payloads
from every registered component; the conservative entity fallback remains so
existing readers rebuild reliably. Retained worlds and previous-step snapshots
remain independent. Highly dynamic worlds can still cause frequent resets.

`journal.empty epoch capacity`, `record`, `record_many`, `cursor` and `read` also
work for arbitrary collections. Change variants are Added, Updated, Removed and
Replaced; IDs retain all 32 bits. Reading coalesces in event order, so the last
operation per ID wins, and returns sorted update/removal sets. Replacement and
retention gaps return Reset, never a partial delta. Coalescing sorts retained
events once rather than repeatedly merging growing sets. A collection owns the
write boundary and must report every relevant mutation.

`ecs/commands.Edit component` is Put `{entity, value}` or Remove `entity`.
`commands.apply constructor edits` is one explicit commit. It keeps the final
edit for repeated IDs, ignores dead/out-of-range IDs and applies surviving IDs
in ascending order. There are no intermediate callbacks or reads inside the
batch. Each touched component leaf/block is copied once. The component revision
advances once for a nonempty surviving selection; journals report final touched
IDs, with absent-to-absent removals omitted. `ecs.edit_selected` is the lower-level
sorted-unique-live-ID path with `Array (Maybe component)` payloads. The generic
`Commands command` buffer supplies empty, push, append and flush; the application
provides its command sum type and effect-checked interpreter. Flush executes
commands in source order and returns an empty buffer. It never reorders separate
command boundaries. Callers retain spawn results in their own resources or
interpreter state, and choose when to flush. This is synchronous deterministic
execution, with the same failure semantics as direct ECS operations.

`ecs/recipe.plan definitions roots` validates unique keys and known dependencies,
selects the reachable requirement closure and rejects cycles in that closure.
It returns Ok Plan or Err Duplicate/Missing/Cycle. Order is deterministic and
dependency-first, with declaration order breaking ties. Planning belongs outside
the spawn loop; it uses a simple schema-size fixed-point algorithm.
`recipe.apply plan overrides present install` runs explicit overrides first,
then installs only missing required keys. Existing values and overrides take
precedence over defaults; dependencies remain required when a root already
exists. `recipe.spawn` wraps the same process in `ecs.spawn`. Applications supply
all presence checks, component constructors and defaults; keys have no hidden
registration or runtime type erasure.

`relations.Relations [source, target]` represents typed many-to-one edges.
`link source_keys target_keys source target edges` atomically retargets the
forward edge and paged inverse buckets, with persistent map sharing. Forward
slots permit swap-removal without searching the incoming bucket. `target`, `sources`,
`unlink` and `remove_target` supply lookup and explicit cleanup. Both key types
use caller-supplied hash/equality policies. `remove_target` removes all forward
edges as one grouped map edit and removes the inverse bucket once. `fold_sources` reduces incoming sources without allocating an array. Incoming
enumeration uses insertion order until swap-removals change it; sort it explicitly if numerical or presentation order matters. Ordinary
link permits cycles. `link_acyclic keys source target edges` is an optional
same-key-kind forest policy, returning Nothing for a new or encountered cycle.
Nothing automatically despawns an entity or removes its relationships. A caller
may maintain this index from a component journal, rebuilding it after Reset.

`messages.Messages value` is a typed bounded paged log. Create it with
`messages.empty epoch capacity`; append using write or write_many. A batch copies
only touched pages, retaining at most capacity values even when the batch is
larger. `cursor` starts at the current end and `beginning` at the oldest retained
item. `read reader log` returns ordered Items `{values, cursor}` or Reset cursor
for a gap, wrong epoch or cursor ahead of the log. Reset points to the current
end: rebuild application state, or explicitly read from beginning if replaying
the retained tail is appropriate. Capacity zero discards all values while
advancing sequence numbers. `restart fresh_epoch log` clears the log; reusing
the current epoch traps, as does sequence overflow. Epoch uniqueness across
replacements is the caller's responsibility. There is no automatic frame expiry,
reader registry, callback chain or scheduling policy. Keep each reader with its
originating stream; it does not identify foreign streams sharing an epoch. Use distinct nominal event
types for independent ECS streams. Persist messages only when the application
requires replay of undelivered events.

See [the complete composition example](../examples/incremental_ecs.blot).

The native prelude reserves `Cursor` for collection iteration. Declaring a
same-named record produced a misleading `type_arity: Array requires one element
type` diagnostic on compiler binary SHA-256 `125682b37dda`. The stream API calls
its cursor record `messages.Reader`. A generic function that clears storage
must retain its element type in its return annotation; otherwise an unused
payload can leave an open ownership root (`ownership_unproved`).


## Prepared storage and construction

`ink/map/frozen.from policy entries` constructs an immutable open-addressed map.
Use the same `map.Key` policy as persistent maps. Separate numeric probe slots
allow all key values, including zero and full-width U32. `get`, `contains`,
`index`, `count`, `keys`, `values`, `entries` and `fold` read the table. Dense
entries follow first-insertion order; duplicate keys keep the first equivalent
key and the latest value. Building reserves at least twice the input count in
probe slots; choose persistent `map` when snapshots need independent edits.

`ink/buffer.empty ()`, `append chunk buffer` and `push value buffer` collect
immutable chunks without recopying earlier payloads. `finish` materializes a
contiguous array once; `count` does not flatten. Old builders remain snapshots.
`ecs/commands` uses this storage: inspect it with `commands.count` or
`commands.values` instead of a `.values` field. Explicit batch boundaries and
interpreter ordering are unchanged. `sound.play_many`, `sound.keep_many` and
`ui/tree.declare_many` publish complete caller-built batches with one resource
write. Empty batches do not write.

`pages.update_pages count dirty_pages replace before` is the leaf-level batch
primitive. The callback receives `(page_index, old_leaf)` as curried arguments
and must return exactly the new leaf length. It runs only for dirty, appended,
or shortened leaves. `page_at page storage` exposes one checked leaf; `fold`
traverses values without flattening. `leaves storage` collects shared leaf
references for repeated indexed scans, without copying payloads or walking the
directory for every value. Collection roots are immutable.

`query.compile filter keys` validates and binds source slots once.
`query.prepare_plan epoch plan sources cache` accepts fresh source snapshots in
that key order. It checks only revisions relevant to membership; Optional terms
still do not invalidate it. Required components drive traversal from the smallest
available occupied-word list. Alternatives/exclusions retain a universe fallback.
Set bits are enumerated directly in ascending entity order.

`ecs.compact references` is an explicit identity-changing boundary. It packs live
entities into dense ascending slots, remaps every registered current and
previous component column, and calls `references remap` before publication.
`remap.previous[new_id]` gives the old ID; `remap.current[old_id]` gives the new ID
or `ecs.no_entity`. The callback must rewrite entity references in component
payloads/resources and reset transient derived caches. External references also
need this map. Old worlds/views remain valid for their old lineage. This does
not silently recycle ordinary U32 IDs or introduce hidden generations.

`path.prepare points` validates a nonempty finite polyline and precomputes
cumulative distances and segment headings. `path.sample prepared distance`
uses binary search, clamps finite distances to the ends, and skips zero-length
legs. Preparation rejects nonfinite cumulative lengths. Cumulative F32 rounding
can differ from repeated subtraction in `path.along` near segment boundaries;
callers choose one representation for deterministic replay.

Small-budget `navigation.astar` uses a sparse index bounded by discovered cells;
large searches and reverse fields keep dense storage. Grid validation records
whether costs are unit-valued so `flow` does not rescan that classification.
Search budgets, predecessor ordering and full-width cell identities are unchanged.
No scratch state or path cache is global.

`ink/graph.from_edges count sources targets` returns Maybe compressed adjacency;
`from_lists` accepts validated node indices and traps on invalid targets. Edges
retain source order and duplicates. `reverse` transposes the graph.
`reachable graph roots allowed` includes all seeds and visits permitted targets
once with a bounded queue. `waves width dependencies` returns deterministic
Kahn waves or Nothing for a cycle/zero width. Ready source indices break ties;
newly ready nodes enter the next wave. Physics uses adjacency for wake
propagation, and recipe/schedule planning shares dependency waves. Recipe ties
now consistently select the smallest ready definition index.

`statistics.quantile` partitions stable source indices with a bounded fallback
sort; equal-valued signed zeros retain their original index order. It rejects
nonfinite inputs and preserves the nearest-rank contract.
