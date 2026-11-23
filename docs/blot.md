# Library API

Import modules as `ink/math`, `ink/ecs`, or `ink/pen/host`. The declarations in
`lib/` define the API. Ordinary modules depend on Ink and the standard library;
only the optional Pen adapter imports generated `pen/` bindings. Applications
own state layout, loops, clocks, assets, policies and resource lifetime.

This guide describes current named-owner contracts. See
[architecture](architecture.md), [testing](testing.md) and
[the continuation](../CONTINUE.md) for boundaries, commands and qualification.
Source checking does not qualify a module's original exports or runtime.

Pass the editor a `hooks` record with `despawn`, `stash_scene` and
`restore_scene` callbacks. Each callback takes the world with `own` and returns
its successor. The editor's `begin` callback follows the same rule. Gdev
supplies these hooks at composition time.

## Functions, owners and borrowing

Use `func` and explicit `return`, curried `->` arguments, `$Constructor`, `true`
/ `false`, and short-circuit `and` / `or`. A result annotation precedes `=>`.
`return` exits the function; `break value` finishes the nearest `do` expression.
Arrays use `#[...]`; `[...]` denotes Lists.

```blot
entry func doubled (count: U32) : Array U32 => return do:
  let values: GrowArray U32 = #[]
  for index in 0 .. count:
    @storage.push values (index * 2)
  return @storage.freeze values
```

`Array T` permits indexed writes at a fixed extent. `GrowArray T` adds append;
`ResizeArray T` also permits shrinking. Declare every owner independently.
`@storage.freeze` consumes growth capability. `@storage.copy` makes independent
outer storage; copy nested payloads under an explicit policy when rows contain
spans, links or views.

`&[T]` captures a borrowed range and length, `&T` names a place, and `^T` is a
checked pool link. None copies data or extends an owner's lifetime.
`values.view start end` uses an exclusive end, like `&values[start..end]`.
`array.slice start count values` instead copies a range specified by count.

Persistent rows contain fixed data and scalar spans into separately named
payload pools. An access record gathers aliases for a call; assigning it does
not make a snapshot. Declare payload owners before rows borrowing them.
Temporary owners can surround a known consumer that finishes reading and
encoding before the scope closes. Never return a fresh aggregate of several
owning arrays.

```blot
entry func checkpoint () : Array U32 => return do:
  let live: ResizeArray U32 = #[3, 5]
  let saved = @storage.copy live
  @storage.push live 7
  live[0] := 11
  return @storage.freeze saved
```

Readonly generic helpers use `.length` and `.at index`; mutation needs a
concrete owner contract. Bind aliases from an access record before mutation
loops, so the backedge carries the needed pool rather than an entire record.
Known callbacks must retain their actual latent effects and live captures. They
are not runtime callable storage. Host calls retain explicit `Foreign`.

`std/array.flatten ranges payload` reads checked `{start,count}` spans from one
separately owned payload. `flatten_read read length ranges` binds a concrete
reader. For unrelated collections, append elements into one named GrowArray and
freeze once; do not build nested owning-array rows.

## Math, transforms and time

`math` adds Vec4, Quat, Color and Ray to `std/vector`'s Vec2/Vec3. Coordinates
are right-handed, +Y up and -Z forward. Quaternions store x,y,z,w; `a * b`
applies b before a. Angles are radians unless a particular API says otherwise.
`normalize_quat` and `normalize3` reject zero/nonfinite inputs and avoid
overflow for finite magnitudes. Zero-axis rotation uses identity; parallel
look/up vectors choose a deterministic perpendicular. Scalar kernels preserve
vector operation order; `unit_quat`, `rotate_parts` and `nlerp_parts` expose
those calculations.

Transform poses store position, rotation and scale; affine transforms store
translation and basis columns. Composition applies child before parent and
preserves shear from rotated nonuniform scales. Inverse rejects singular or
nonfinite results. Pose interpolation uses linear position/scale and the shorter
rotation arc, with unclamped weight.

`time.fixed step limit remainder delta` returns checked steps, remainder,
interpolation alpha and dropped seconds. Whole ticks beyond the catch-up limit
are discarded; zero limit discards all whole ticks. Seconds must be finite and
nonnegative, step positive. Boundaries follow F32 precision. Timers expose tick,
one-time expiration and overshoot; there is no hidden clock.

`clock.advance` runs known checkpoint/update stages against a named clock owner.
`app.stages` composes
reset/start/normalize/checkpoint/route/interface/event/update/ render/settle
functions over explicit application access. Each stage has its own effect row.
Parenthesize a curried stage's final callable to attach effects to that call.
Control and wall time have separate owners. Invalidate after explicit restore;
normalize/checkpoint run at the next boundary. Reset output only after preceding
encoding finishes.

Random state is an explicit U32 seed. Zero restarts from a fixed seed; unit
samples use the high 24 bits in [0,1). Noise repeats for fixed seed/coordinates,
and zero fractal octaves yield zero. Use explicit U32/F32 conversions at packet
boundaries. F32 cannot preserve every U32 above 2^24: use the U32 ABI, word
codecs or exact 16-bit halves for identities.

## Maps, sets, deltas and handles

Maps have separate `map.Map [key,value]` rows from `map.empty ()` and bucket
storage from `map.buckets ()`. Policies are known hash/equality functions.
`map.u32` preserves full-width keys; `map.text` reads character views whose
owners must outlive stored keys. F32 policies explicitly define NaN/signed zero.

| Operation                                                                     | Contract                                        |
| ----------------------------------------------------------------------------- | ----------------------------------------------- |
| `get policy key rows buckets`                                                 | Optional lookup                                 |
| `set policy key value rows buckets`                                           | Insert/replace; retain first equivalent key     |
| `remove policy key rows buckets`                                              | Remove in place                                 |
| `from policy entries rows buckets`                                            | Ordered insertion; later duplicate values win   |
| `set_many`, `remove_many`, `edit_many`                                        | Ordered edits to named storage                  |
| `entries rows`, `keys rows`, `values rows`                                    | Independent arrays in surviving insertion order |
| `copy_into policy copy_key copy_value destination destination_buckets source` | Explicit destination and payload policy         |
| `clear rows buckets`                                                          | Reset both owners                               |

Removed rows are tombstones; enumeration scans inserted rows. Compact/reset
explicitly. Sets use Unit-valued rows and a separate bucket pool, with explicit
mutation destinations. `map/frozen.from equal entries` builds one fixed ordered
table using equality, not mutable-map buckets. Hashes are deterministic and
noncryptographic; save logical entries rather than bucket positions.

`changes.borrow reset updated removed` borrows a logical delta. `make_into` and
`compose_into` normalize into distinct updated/removed owners: removals win and
composition applies the later batch last.
`reconcile.match_keys before after
previous added removed` writes three named
outputs and returns their views. Duplicate inputs are rejected before publishing
output.

Page writers take the owner and return its successor. For example,
`rows := pages.set index value rows` updates one row. Use `pages.copy_using`
to keep the old rows. Buffer and command pools have separately named owners.
Views borrow; retaining predecessors requires explicit copies. History has a
separate ring and metadata containing capacity/head/count.
`history.values
buffer meta` returns chronological values. Timestamped history
rejects backward or nonfinite samples.

Handles tie opaque `Handle kind` to nominal `Store [kind,value]`, whose kind
witness aliases the actual payload pool. Dense-owner IDs, slots, free slots and
metadata remain separate named owners. This protects storage access, not merely
the handle's annotation.

```blot
import * as handles from "ink/handles"

type Item is data = $Item
entry func item () : U32 => return do:
  let rows: ResizeArray U32 = #[]
  let values = handles.store $Item rows
  let owners: ResizeArray U32 = #[]
  let slots: ResizeArray handles.Slot = #[]
  let free: ResizeArray U32 = #[]
  let meta = handles.metadata 7 1 8
  let $Some target = handles.insert $Item 42 values owners slots free meta else:
    return 0
  return Maybe.unwrap_or 0 (handles.get target values slots meta)
```

`handles.handle_pool kind` creates one named opaque-handle pool. Stale
generations and foreign region/origin are rejected. Dense swap-removal updates
the moved slot; serialization preserves U32 identities. Descriptor assignment
aliases payload; checkpoints need separate owners.

## ECS, queries and commits

`ecs.Entities` is a named live-bit pool; every component has a separate
`ecs.Pool a = ResizeArray (Maybe a)`. Entity/component metadata and application
resources have independent owners. There is no registration builder, ambient
world lookup or implicit component store.

```blot
import * as ecs from "ink/ecs"

entry func component () : U32 => return do:
  let alive: ecs.Entities = #[]
  let entity_meta = ecs.metadata 1
  let values: ecs.Pool U32 = #[]
  let value_meta = ecs.metadata 1
  let id = ecs.spawn alive entity_meta
  ecs.insert alive values value_meta id 17
  return Maybe.unwrap_or 0 (ecs.read values id)
```

IDs grow monotonically within an epoch. Despawn clears relevant columns through
the explicit application schema. Structural/payload revisions remain observable.
`ecs.copy_into copy_value destination source` copies under an explicit payload
policy; current/previous columns must have distinct owners. A view is not an old
world. Identity compaction/remapping must also rewrite application references
and reset transient caches.

Query filters are flat With/Without/Optional/All/Any terms. Bind each source
with `query.source key pool metadata membership`, using named Bool membership
scratch. `query.prepare alive entity_meta filter sources key indices meta`
writes explicit cache identity and selection. Supply fresh source views each
invocation; membership caching does not cache component values. Epochs identify
one lineage; replacements/forks require a fresh epoch or cold independent cache.
Revision counters trap before wrapping.

`commands.apply alive pool meta edits` coalesces Put/Remove edits: later wins,
dead IDs are ignored, final IDs commit ascending. Generic commands use an
application ADT and known interpreter. Flush runs source order then truncates;
schedule follow-up work into a different queue.

Recipe requirements contain spans into one dependency-key pool.
`recipe.plan
definitions requirements roots destination` validates
keys/spans/dependencies and reachable cycles, then writes dependency-first keys
with declaration-order ties. Plan outside spawn loops. Apply runs overrides
before missing defaults; presence checks and constructors are application
functions. Relations use typed keys and named forward/inverse storage; cleanup
and forest policy are explicit. Swap-removal can change incoming order, so sort
when deterministic reduction requires it. See
[incremental_ecs](../examples/incremental_ecs.blot).

## Messages, journals, queues and derived values

Messages use separate log and `messages.metadata epoch capacity` owners.
`read reader log meta destination` copies ordered retained rows into the named
destination and returns borrowed Items or Reset. Gaps/wrong epochs/ahead readers
reset to the current end. Zero capacity discards rows but advances sequence;
restart needs a fresh epoch and sequence overflow traps.

Journals record Added/Updated/Removed/Replaced through bounded storage.
`journal.read_into reader log meta scratch updated removed` coalesces into
explicit owners. Gaps/replacement return Reset, never partial deltas. Adopt a
reader only after consuming its result. Readers do not consume one another.

`task_queue` is a typed application data queue, not a language task runtime.
Name queue, metadata, history and accepted-result owners independently. Tickets
contain epoch/sequence. Encode/decode take explicit metadata and known codecs.
Completion, cancellation, rejection and publication retain separate boundaries.
Persist data through the application schema rather than retaining live host
work.

Derived Source/Cache contain fixed values and metadata. Variable source payloads
belong in named pools, referenced by scalar length/span. Evaluate takes explicit
dependencies, known compute, scalar cache and retained dependency owner. A fork
needs copied cache metadata, independent dependency storage and a payload
policy. Causes, hit/compute counters, clock region and ordered keys remain
observable.

## Graphs, schedules and copied workers

Graphs use compressed adjacency in separate starts/target owners. `from_edges`
and `from_lists` write explicit outputs; the latter reads borrowed list views.
Edges retain source order/duplicates. Reverse writes a separate graph; reachable
includes seeds and visits permitted targets once. Waves use ascending ready
indices, delaying newly ready nodes to the next wave; cycles/zero width reject.

Schedules contain flat read/write/after spans into a channel owner.
`plan width
nodes channels dependency_starts dependency_targets wave_starts wave_nodes`
writes all four destinations. Ordered/Unknown modes form barriers. Prepare
validates and borrows waves, whose owners must remain live and unchanged.
`execute plan access dispatch commit` returns Bool and mutates explicit access;
`execute_prepared` skips repeated validation. Dispatch reads an ascending wave;
all result counts are checked before that wave commits in source order.

Partition ranges coarsen count into balanced nonempty jobs, capped by maximum
and at least minimum unless the entire input is smaller. Zero count gives no
ranges; zero limits trap.

Pure multi-core batches use Blot's first-class `entry kernel` declarations with
prepared immutable contexts (`KernelPool`) and isolated stateful `entry process`
workers (`Processes`); legacy `pen/workers` and `pen/worker_session` callback
adapters are retired. Workers never share a live ECS world; callers revalidate
application revisions before accepting stale results.

## Persistence and generated codecs

Persistence runs known schema functions over concrete application access.
Section metadata, payload, outcomes, requests and packets have separate owners.
Decode mutates explicit destinations; restore resets derived caches and
journal/query epochs. Previews need independent pools, including payloads.

Word persistence retains exact U32 payloads. Current component rows require live
IDs. Only the previous-snapshot restore path permits historical rows despawned
since the checkpoint, within the saved column/alive extent. This does not revive
entities or change their epoch. Counts, sorted/unique IDs, widths, decoder
bounds and exact packet consumption remain checked.

Lanes supplies exact/finite guards and codecs. `codec.pack` splits U32 into
exact F32 halves with strict capacity/padding. Preserve signed-zero/word-level
witnesses. Models use flat spans with separate payload sections. Change
inputs/templates and regenerate, never hand-edit derived source or bypass custom
codec policy to hide an emission failure. See [state](state.md).

## Geometry, terrain and physics

Terrain borrows a named sample owner. Make takes origin, square size, cells,
grid and procedural parameters. Samples are (cells+1)^2 in row-major -Z/-X
order; scale authored heights first. Missing samples contribute zero. Height
continues at the border outside the square, as does procedural detail. Normal/
gradient default to 0.5 m central differences. Applications integrate gravity.

Terrain collision is finite, static and world-authored, with boundary walls;
source rotation/scale do not transform it. Numerical closest-point refinement
uses half-grid/quarter finest-detail wavelength and a 0.1 mm floor, not an
analytic global-distance guarantee. Work grows with footprint/frequency. Lower
collision bounds use -1e9 m sentinel.

`shapes.Geometry` aliases six named point/plane/ring/index/height/source-plane
owners. StoredShape/StoredPoly contain spans; logical geometry borrows them.
Brush edits take destination face pool first; Stored brushes hold fixed
placement and spans. Editor drag origins require independently copied faces.

Scene Sources carry world pose, collider, optional rigid/walker and borrowed
planes. Source indices address caller rows; unique positive U32 IDs determine
query/contact ordering. `scene.access` takes named geometry, proxy, BVH and slot
owners. `build_into destination sources` takes and returns a Scene. Geometry
can contain authored payloads. Clear it only after its borrowers have finished.
`update sources current changed_indices` returns the updated scene. Report every
pose, shape, body kind, layer and collider edit. Source count or collider
presence changes rebuild the tree. Dirty hull updates reuse compatible geometry
spans. Retaining an old scene requires independent geometry, proxy and tree
pools and an explicit nested-payload copy policy.

Spatial build/copy take named destinations. Refit takes parallel dirty indices
and bounds, ignores invalid indices, keeps the last duplicate and traps on
length mismatch. Rebind the index from the result. Query results retain source
order. Closest ties choose smaller source index. Closest lower bounds must
conservatively cover descendants and the score limit is inclusive. Refit retains
leaf partition; rebuild after widespread motion when pruning deteriorates.

Scoped cell/area constructors keep scratch alive through known consumers.
Nonfinite points or invalid bounds are omitted. Stored point grids preserve
source identity; query order is not a tie policy. Resolve ties explicitly.

`physics.StepAccess` holds source rows, geometry, two-bank contact cache and
results. `step_into` and `step_joints_into` take it with `own` and return it
(`step := physics.step_into config dt step`). `simulate_into` does the same
with a built scene. Source payloads, contact banks and results have named
owners. The active bank is a scalar on the cache. Contacts retain exact U32 IDs,
point, normal and impulses. Replacing IDs
discards stale contacts. Triggers are queryable but not solver contacts.

Config controls gravity/substeps/sleep. Static sources stay fixed; kinematic
motion belongs to callers. Walkers receive velocity including caller gravity/
jumps; rigid bodies use gravity_scale. Nonpositive/nonfinite dt does no update.
Queries take masks/skip IDs; solids ignore triggers, overlaps include them.
Walker slope is degrees, quaternion angles radians. Joints use source indices,
metre anchors and local axes; springs N/m and N·s/m, motors rad/s and Nm.
Invalid/self joints are ignored and connected dynamics remain awake. One joint
pass per substep has no angular limits, break threshold or warm-start cache. See
[physics](../examples/physics.blot), [steps](../examples/steps.blot) and
[joints](../examples/joints.blot).

Tiles use bottom-left row-major IDs and solid/oneway/ladder/hazard flags. Slide
returns corrected position/velocity and collision directions; drop permits
passage through one-way platforms.

## Netcode: rollback and replication

Transport, clocks and loops stay in hosts; both modules exchange `#[U32]`
packet words and take every owner explicitly (see
[the two-peer example](../examples/rollback.blot)).

`rollback` follows GGPO. `Config {players, lanes, window, delay, local,
interval, redundancy}` is shared by all peers; inputs are `lanes` U32 words per
player. `make config` returns a `Rollback` holding only input rings, ack and
checksum bookkeeping. The caller owns `state`, a saved-state `ring` of
`snapshots config` slots (`slot config frame`) and four compile-known
callbacks: `save slot state ring`, `load slot ring state`, `checksum slot ring`
and `step state inputs` (inputs are `players * lanes` words), plus
`predict player frame lane last_word` (`repeat_last`, or your own).

| Operation | Contract |
| --- | --- |
| `advance predict step save load checksum local_input s state ring` | Roll back and resimulate if a remote input contradicted a prediction, then simulate one frame. Returns `(s, state, ring, Outcome)`; `$Window`/`$Backlog` stall without consuming the input |
| `resolve predict step save load checksum s state ring` | The rollback half alone, for draining after the last frame or while stalling |
| `receive packet s` | Validate the whole packet, then apply inputs, acks, advantage and checksum report; returns `(s, Bool)`. Duplicates, reordering and overlap are safe; malformed packets change nothing |
| `encode s to latency` | Fresh packet for peer `to`: up to `redundancy` inputs from its acknowledgement, our acks for everyone, advantage, latest final checksum, trailing hash |
| `local_frame s`, `current`, `frontier`, `settled`, `input_at` | Sample index is `local_frame s - delay`; the frontier is the first frame lacking a confirmed input; states up to it never roll back |
| `advantage s player latency`, `recommend s latency` | Frames ahead of a peer (latency in frames from your clock) and how many frames to stall to even the lead |
| `desynced s`, `desync_frame s` | Set when a final-frame checksum differs from a peer's report (every `interval` frames) |

A local sample taken for frame `f` applies at `f + delay`; frames below `delay`
are zero everywhere. Rollback depth is at most `window`; at that depth `advance`
stalls. `s.deepest`, `rollbacks`, `resimulated` and `stalls` count it. The ring
holds `2 * (window + delay) + 4` frames per player, so a peer that stops
acknowledging stalls us instead of overwriting unsent inputs. Frames are plain
U32; the module assumes sessions shorter than 2^31 frames.

`replication` keeps a `Snapshots lanes capacity` store of time-ordered rows
(server baseline history or client jitter buffer). `push time seq row store`
inserts in order and rejects duplicates, non-finite times and rows older than a
full store; `trim time` discards rows that can no longer bracket it. `sample
store time max_extrapolation lerp out` returns `(out, Sample)`: exact rows copy
untouched, between rows `lerp lane a b t` blends words (`lerp_f32` blends F32
bits), extrapolation uses weight above one for at most `max_extrapolation`
seconds, and earlier times or a single row hold. Callers subtract their render
delay from their own server-time estimate.

`encode seq time baseline base current` writes a full row (`baseline = none`)
or a changed-lane mask plus changed words, comparing words so NaN payloads and
signed zero survive. `decode_header lanes packet` validates framing, hash, mask
padding and exact length; `decode_into packet base out` reconstructs or leaves
`out` untouched. `receive packet store` finds the baseline by sequence and
returns an outcome (`accepted`, `malformed`, `missing_baseline`, `rejected`).
Servers call `encode_for acked history seq time current` with
`acknowledge client seq acked` per client (stored as sequence plus one, never
lowered) and `encode_ack`/`decode_ack`.

## Navigation, steering and placement

Navigation grids borrow validated four-neighbor costs: positive enters a cell,
zero is wall. `astar_into cells grid start goal limit` writes named path
storage; `flow_into costs next grid goal` writes reverse costs/successors.
Unreachable cost is 3e38 and successor sentinel cell count. Budgets and ties are
explicit; no scratch/cache is global.

Ground uses named box/round/word/shape storage or scoped construction over valid
inputs. Make/reuse/read operate on fixed Stored spans. Reuse requires identical
ordered shapes/radius. Packet version 1 allows at most 1,024 obstacles and
finite coordinates/radii bounded by 1,000,000; invalid rectangles, negative
radii, fractional counts and trailing lanes reject. Encode does not clamp data
to fit.

Lookahead has eight waypoints and 128 steps of at most one second, writing
points to explicit storage. Selection prefers arrivals, then shorter arrivals;
unfinished forecasts compare progress then shorter distance. First exact ties
win; over eight alternatives reject. Revalidate actor/world revisions before
accepting old work.

`navigation/mesh` holds convex polygons on the XZ plane: `Storage` owns flat
`vertices` (x,y,z triples; y is height), `corners` (vertex ids), `links`
(polygon across each edge or `mesh.none`), `polys` (`{start,count}` spans) and
area `centers`; `mesh.read storage` borrows a `Mesh`. Polygons wind so
`cross(a,b,c) = (bx-ax)(cz-az)-(bz-az)(cx-ax)` is positive; collinear corners
are allowed. `make_into storage positions counts indices` returns
`(ok, storage)` and rejects (leaving storage unchanged) NaN, fewer than three
corners, repeated or coincident consecutive vertices, zero area, concave or
self-overlapping rings, clockwise winding and edges shared by more than two
polygons or twice in one direction. Links come only from shared vertex ids: a
T-junction does not link, so split the long edge. `from_grid_into storage grid
left front size` merges equal-cost walkable cells greedily (row-major, widest
run, then deepest rows) and puts every grid vertex on a rectangle's boundary so
neighbours link along unit edges; coverage equals the walkable cells exactly.
`index_into` buckets polygons into a caller-owned uniform grid (`IndexStorage`
plus `Frame`; `index_read`); `locate` returns the lowest containing polygon
(1e-5 m slack), `locate_spot`/`closest` return a `Spot` with interpolated height
(`poly == none` when nothing is found). `walk mesh poly sx sz ex ez` follows a
straight segment across shared edges and reports `blocked`, the last polygon and
the reached fraction.

`navigation/heap` is the shared lazy min-heap (smaller key, larger tie, smaller id).
`navigation/corridor` searches polygons with A*: stepping P to Q costs the
distance from P's centre to the midpoint of their portal (the run of edges
linking them) plus on to Q's centre, so the result is the exact cheapest polygon
route. `search_into work mesh start goal limit` takes `Spot`s (use `closest` to
snap outside points), writes `work.corridor` and returns `(work, Route)` with
status `found`/`unreachable`/`exhausted` (budget in expansions)/`invalid`.
`navigation/funnel.pull_into work mesh start goal radius` string-pulls the
corridor into `work.path` (x,y,z triples). Each portal's ends move `radius`
toward each other (a portal narrower than `2*radius` collapses to its midpoint),
so corners keep `radius` from wall vertices; oblique crossings can still pass
closer, so erode the mesh for exact clearance. All work pools are reset per
search (linear in polygon count).

`navigation/anyangle` adds `astar8_into` (eight neighbours, no corner cutting,
cost `costs[entered] * length`, octile heuristic) and `theta_into` (Theta*,
any-angle, uniform cost, Euclidean lengths, exact integer line of sight where a
segment through a grid corner needs all four cells walkable); both return
`(work, Result)` with waypoint cells in `work.cells`. `navigation/flow` builds
resumable Dijkstra integration fields from many goals: `begin_into`, repeated
`step_into flow grid limit` (reports done), then `directions_into` writes unit
directions (two per cell) following the cheapest legal move; `flow_into` does
all three. Buffers are caller-owned and reused.

`avoidance` is RVO2's ORCA: `velocity_into work agents index neighbours set
edges preferred_x preferred_y params` builds half-planes for neighbour agents
(rows of x,y,vx,vy,radius) and obstacle edges (`add_into` makes vertex records
from closed polygons or two-vertex walls; counter-clockwise keeps agents
outside), solves RVO2's incremental 2D program, and falls back to its 3D
program when infeasible. It returns `(work, Velocity)` with status
`feasible`/`relaxed`/`invalid`; `work.lines` keeps the constraints. Neighbours
are sorted by distance then index and capped by `max_neighbours`, so caller
order does not matter. A zero horizon leaves only overlap responses; coincident
agents split along ±x by index; nonfinite input yields a zero velocity.

Steering is pure, using caller neighbor snapshots/integration. Scoped flock
construction indexes position/velocity/group arrays. Neighborhood collects same-
group center/heading and all-group separation, bounded by first candidates in
cell order. Coincident members separate by deterministic index direction;
nowhere members do not participate. Flocking caps acceleration, angular stray,
turn rate and speed. Stray below a right angle preserves progress toward a goal.

Avoid makes one solid sphere cast along velocity for the horizon. Urgency is
1-distance/reach: remove inward goal motion, steer along the surface and push
out of overlap. Clear/nonfinite/zero motion yields zero. Terrain participates
unless excluded by mask. Physics handles motion steering misses.

Placement uses deterministic priority thinning in global integer cells.
Half-open adjacent chunks join, including negatives within F32 exact integer
range. It guarantees minimum spacing, not maximal fill. Neighbor work grows with
spacing/cell ratio. Weighted choice skips zero and rejects invalid/all-zero
input.

## Motion, animation and behavior

Camera projection/picking helpers use explicit perspective or orthographic
parameters and the caller's world pose. Distances are metres, vertical field of
view radians, NDC +Y up and depth [0,1]. Both depth directions are supported and
quaternions normalized. Project/unproject/pick reject invalid/nonfinite results;
matrix/frustum require a valid camera. Culling returns input-order indices and
is conservative. Render visibility and LOD remain separate policies.

Color linear/sRGB conversion preserves alpha and HDR range. Exposure is stops;
tone mapping uses an ACES-inspired fitted curve, not the full ACES pipeline.
Power takes finite nonnegative bases; checked logarithm requires positive finite
input. Low-level log2 floors positive subnormals to 1.17549435e-38 and exp2
bounds exponents to [-126,126]. Material BRDF includes NoL before incoming
radiance; directions point out of the surface. Local lights have finite range.
Environment samples include solid-angle weights summing to 4π; nine real SH
coefficients give diffuse irradiance before albedo/π. `environment.project sky
rows columns` integrates a sky's gradient, its sun left to the directional
light, on a rows × columns equal-area midpoint grid (16 × 32 is enough; the
sqrt-height kink at the horizon and the grid's band-2 error cost about 0.5%).
`environment.diffuse irradiance ambient` turns that into the nine albedo-ready
terms a host shades with (irradiance/π, scaled per channel so the sky's average
over all directions is the flat `ambient`; a uniform sky returns it to the grid's 0.25%,
a dark channel stays dark) and the per-channel `tint` from sky colors to that
light. `graphics.ambient lighting` applies it to `graphics.sky`, and
`pen/host` sends the tint and coefficients as `sky.tint` and `sky.sh0..8`,
which Pen's renderer reflects and shades with (`ambient_light` and
`sky_reflection` in its `ENVIRONMENT_WGSL`). Its cube map of the sky is the
same horizon/zenith/ground gradient, so Blot and the host share one sky
definition. `probes` bakes bounced light into a caller-owned lattice (below).
Shadow fitting requires
resolution at least two, reserves snapping slack and admits off-screen casters
via padding.

`probes.Grid {origin, spacing, nx, ny, nz}` names a lattice of diffuse light
probes, stored flat in a caller owner of `probes.stride` (28) floats each:
nine RGB SH terms as `environment.diffuse` has them (irradiance/π) and a
validity weight. `probes.empty_values grid` makes the owner;
`probes.bake_range scene light grid albedo previous first budget values` bakes
that many probes from `first` (`probes.resume` gives the next start, wrapping),
and `bake_listed` the probes a `probes.region grid low high margin` list names
after solids in the box changed. Each probe casts `light.rays` rays on a
spherical Fibonacci set (no random state) through `scene.ray`: escapes see
`light.sky` times `light.tint`; hits reflect `albedo id` times the sun, with a
shadow ray, plus the sky's ambient. Pass an earlier bake as `previous` for a
further bounce: hits then take its light (trilinear, as sampled) instead of
the open ambient, which darkens a closed room as it should. A probe inside a
solid, or with at least a quarter of its rays starting inside one, is invalid
(zeros, validity 0) and weighs nothing in sampling. `probes.sample grid values
position normal bias` interpolates in Blot: trilinear at the point lifted
`bias` along the normal, each corner weighed by validity and a smooth facing
term, exact at a probe's centre with bias 0; `confidence` is 0 outside the
lattice, fading in over one cell beyond its edge, and the share of valid
corners inside; blend toward the sky with it. Publish a volume with
`render.ProbeSet`: `values` the whole owner when the revision changes, an
empty view otherwise, and the host keeps it. Scene rays march distance
fields, so a probe's rays cost like any other cast; budget bakes across frames.

Director evaluates shots through known `U32 -> Pose`. A settled blend keeps its
outgoing shot live; interruption freezes the reached pose to prevent jumps.
Blending to the current live shot changes nothing; zero duration cuts and
invalid times reject. Pose interpolation uses linear position, slerp and equal
focal-length ratios for positive finite lenses, with exact endpoints. Shake is
camera-local translation in metres and axis-angle rotation in radians. Its
16-lane codec retains full-width shot IDs through exact halves.

A scene query borrows its proxy rows, bounds, ordering and shape geometry as
slices. Preparing physics adds read-only source and ID columns. Both views end
before the owner is resized or refreshed. Use `scene.copy_into` when a later
frame must retain an independent snapshot.

`path.prepare points` returns a prepared polyline with a read-only view of its
points and one owned table of cumulative distances and headings. Sampling skips
zero-length legs, clamps finite distances and rejects nonfinite distances.
Cumulative F32 distance rounding can differ from repeated subtraction in
`path.along` near boundaries; choose one representation for replay.

Spline preparation writes two separate resizable coefficient/arc-table owners
with `spline.make_into` or `make_loop_into`. The returned Spline borrows both;
invalid input leaves the destinations unchanged. Open curves need two distinct
points and loops three; nearby consecutive duplicates are skipped. The curve is
centripetal Catmull-Rom. Arc tables use 16 steps per segment, three-point
Gauss-Legendre quadrature and compensated accumulation, followed by bounded
lookup/refinement for sampling. Open distances clamp; loops wrap. Keep table
owners live and unchanged while retaining the descriptor. Rig dolly/follow
helpers consume these explicit paths without owning a camera or clock.

Rig follow settings use metre offsets/dead zones, seconds of lookahead, angular
spring frequency and damping ratio. The anchor follows the lead point only
outside its dead zone; focus and eye springs treat goals as moving steadily
through the timestep. Turn uses 1-exp(-rate×dt), while invalid/nonpositive dt
keeps state. Start fresh after cuts/teleports. Framing finds an eye for the
specified rotation and angular padding, rejecting empty/nonfinite points or an
unrepresentable near/far fit. Collision sweeps a sphere from pivot to eye;
overlap starts stop at the pivot, and masks/skip/trigger policy stay explicit.
Dolly aim is Along, At a point or Fixed rotation.

Motion integration is semi-implicit Euler: velocity first, then position.
Scalar, four-lane and column forms preserve operation order and signed zero;
unequal columns trap. Signed finite timesteps are supported and overflow follows
F32. Retain columns rather than repacking records for each SIMD call.

Springs use angular rad/s and damping ratio across all damping regimes. Checked
inputs are finite, frequency/damping/dt nonnegative and frequency×dt ≤8192.
`springs.columns_into` takes its position and velocity outputs with `own` and
returns them as `(p, v)`. It uses prepared coefficients, scalar ordering and
scalar tails. At zero dt it copies the input values. Output lengths are checked
before writing. Seeded kicks/settling carry
explicit camera impulses. Particles use fixed scalar rows; stable expiry follows
constant acceleration. Billboard corners are BL,BR,TR,TL and atlas UVs top-left.
Packed vertices are xyz uv rgba, nine F32/36 bytes, facing local +Z; invalid
atlases yield no UVs.

Animation keys/tracks/events have separate owners. Track `{start,count}` spans
the key pool; Clip borrows all three. Validate finite positive duration, poses,
span bounds and sorted key/event times at import. Keys lie in [0,duration],
events [0,duration); later duplicate keys win. `sample_track keys track time`
uses bounded upper-bound search. Parents precede children; U32 max marks roots.
Root motion unwraps reverse/forward loops with exact cycle indices within ±2^24.
Events cross (previous,current]; reverse windows produce none. Cycle difference
must be below 4096 and candidate cycle×event count fit U32. Invalid windows
yield neutral motion/no events. Preserve U32 event identity and wrap ordering.

`animation/ik` works on world-space joints and rotations. `two_bone root mid
end target pole soft weight` returns `Maybe Chain` (new `mid`/`end` plus the
world `root_delta` and `mid_delta` rotations). A pole is a direction from the
root. Bone lengths hold for every weight, because weight turns the two bone
directions along their arcs (zero returns the input, weights clamp to [0,1]).
Reach follows `soft_reach low high soft distance`: identity up to
`high - soft*high`, then a C1 rational approach to `high`; soft zero is a hard
clamp, and targets nearer than |l1-l2| fold the chain. A pole parallel to the
reach axis keeps the current bend side, then takes a deterministic
perpendicular; zero-length bones, a target at the root and nonfinite inputs
(Nothing) are defined. `aim_rotation rotation axes direction up limit weight`
turns caller-chosen local `forward`/`up` axes at a world direction (zero `up`
means swing only). Limit bounds the total turn in radians; weight scales it.
`aim_chain` spreads one aim over a spine/neck/head chain by nonnegative shares
and the tip reaches the aim unless limited. Results are world rotations;
convert to local with the parent's conjugate.
`animation/feet.place settings dt pelvis feet slots` takes caller ground hits
(height and normal per foot at the animated sole; the caller ran the
terrain/scene queries) and a `plant` weight per foot. It returns `(ok, pelvis,
slots)` taking `slots` with `own`. The pelvis offset follows the lowest planted
ground (clamped, exponentially smoothed by `pelvis_rate`/`foot_rate` per
second), each slot gets a sole/ankle target, a foot rotation aligned to the
normal within `align_limit`, and a sole never below its ground. dt zero keeps
all state; invalid input returns `ok` false with state unchanged. Start slots
from `feet.rest`.
`animation/blend_space` turns a parameter into `Weights`, at most three
(clip, weight) pairs, nonnegative, summing to one. `evaluate1` is linear
between sorted samples and clamps (equal positions step to the later sample).
`evaluate2` uses caller-authored `Triangle` rows into the sample pool: the
nearest valid triangle (distance zero inside) supplies barycentrics, so weights
are continuous across edges and exact at samples. Degenerate triangles are
skipped, and with none the nearest sample wins. Outside a nonconvex mesh the
nearest-point rule may jump between ties. `duration` is the weighted cycle
time, `advance` steps a normalised phase, and `sample` blends the clips at one
phase so different-length cycles stay in step.
`animation/machine` is a state machine over caller tables: `Graph` borrows
`State`, `Transition` and marker pools; `Machine` and four `Slot` rows are the
caller's runtime state and `step graph durations flags dt machine slots`
returns `(ok, machine, slots)`. Transitions read caller flags (`step`) or a
known callback (`step_with`), fire first-match per step, and cross-fade by a
`tween` ease with `Sync` none, phase or markers. Slot weights sum to one and are
monotone while fading; interruption keeps the running blend and obeys the
`Interrupt` policy. `evaluate slots sample` blends the pose a callback returns
for each active state/phase, so a state may be a clip or a blend space.
`layers base rows poses references masks` applies override layers (masked
`lerp3`) and additive layers (`base + weight*(layer - reference)`, exact
identity when the layer equals its reference). The module keeps no clock; dt,
durations and flags are explicit, and dt zero advances nothing.

Tweens use caller time and type-provided lerp. Invalid times, negative duration
and overflowing ends reject; zero duration jumps at start. Eases hold exact
endpoints; Back may overshoot and zero Steps acts like Hold. Quaternions use
shorter-arc slerp with near-angle normalized fallback. Redirects start at
current values to avoid jumps.

Timelines hold endpoints outside their interval and later duplicate keys win.
Cues preserve equal-time order. Playback supports Once/Loop/PingPong and
negative speed, with finite nonnegative elapsed time. At most 64 passes emit;
excess whole traversals drop, paired for PingPong continuity. Forward fires
(from,to], reverse [to,from); inclusive start applies after play/seek/restart.
Traversal order stays observable, including equal-time reverse cues.

Behavior Program borrows sorted node rows; build_into writes named node storage.
State has fixed version/step/time/local/status. Frames and visited IDs are named
owners passed to advance with time/budget/stack limit and known
action/condition/ cleanup functions. Successful advance publishes frame/trace
outputs; invalid input leaves them unchanged. Encode takes state plus frames,
restore_into takes destination frames. Generated graphs use these same owners
and originate from graph/model inputs, never manually edited derived files.

## Rendering, UI, sound and services

FrameAccess aliases named settings/output pools. Begin resets only after prior
encoding. Emit copies draw rows into the pool; finish borrows current
RenderFrame. It neither copies a snapshot nor flushes a hidden chunk builder.
Copy stage-local text/extra vectors/nested draws into older frame payload owners
before publishing rows. Solids borrow faces, fields borrow numeric patches and
insets borrow draws.

`render.layer draw access presentation` offsets only new inset boundaries by the
prior sprite count. Equal boundaries preserve order. Standalone column helpers
test visibility before interpolation and keep entity order; missing previous
pose uses current pose. Retained rendering names state/entries/ID payload
separately. Update reads borrowed group views and normalizes dirty IDs. Keyed
update requests necessary keys; host rejection requires full replay, not another
simulation advance. Independent forks copy all retained owners.

Sphere columns validate finite equal lengths/nonnegative radii.
`bounds.classify_into` writes caller-owned visibility and projected-diameter
arrays, checking their lengths first and preserving source order with
independent SIMD lanes and scalar tails. LOD requires positive near/focal and
representable arithmetic. Field dirty comparisons include missing zeros, treat
NaNs as changed and signed zeros equal. Preserve packet padding/tail and scalar
numerical witnesses.

Input pointer/held/new/button state has separate owners. Read borrows them;
decode_into restores explicit destinations. Copy keys when old shortcut/replay
input must survive later events. UI Nodes borrow label/description/value text;
declare_owned copies into older label storage first. Focus and marked nodes
have separate owners. Rebind Focus from `tree.settle` and `tree.decode_into`.
For older saves, run `tree.migrate version values` before decoding. Rebind
prepared topology from `tree.prepare` or `tree.update_prepared`. A topology
revision covers node IDs and parents, and dirty indices cover property edits.

Editor history uses entry spans, saved lanes, metadata, stash and scratch. Undo/
redo decode into explicit access. A drag origin, undo state or preview cannot be
retained by alias assignment. Text reads U32 characters from arrays or views;
console ordering is stable code-point order. Applications own fonts, layout,
dialog and outline state; encode temporary UI payloads before scopes close.

Audio mixing validates gain/pan/Doppler/lowpass inputs; scene query casts once
after validation. Playback and query cadence belong to host/application. Sound
Access aliases named sound/voice/bus pools. Services aliases next ID, requests,
waiting, partial answers, answers, statuses and numeric payload; rows use spans.
Retries and answer consumption have explicit boundaries.

Pen host encodes inside these lifetimes. Session protocol 2 retains explicit
checkpoint/restore and presentation acknowledgment. Semantic observations carry
caller-selected schema/identities/decisions in extensions without mutating
simulation. Generated wire bindings come from the sibling generator. Source
migration implies no ABI/session/schema/capacity bump.

## Compiler evidence and limits

Separate source checks, original-export emission and executed tests. Inventory
unused positive declarations too; demoting entries does not qualify original
ABI, latent effects, row admission or execution.

Concrete result/reader types matter across imported generic boundaries. Use real
Maybe/Array/row contracts when early empty constructors or generic reads leave
payload evidence open. Explicit numeric conversions avoid unresolved `from`
inside a comparison. Preserve effects and guards; no dummy owner or unchecked
cast repairs missing evidence.

Tracked frontiers include empty row pools with borrowed nested fields, generic
custom Codec method emission and SIMD lane-literal forwarding through standard
wrappers. Opaque imported sums and loop-carried variant regressions have focused
candidates whose qualification depends on selected binary/affected tests. Keep
standard SIMD wrappers and complete empty/populated/malformed/reference
workloads while resolving the backend. Source migration is not proof these cases
execute.

A `break` inside a loop that updates fields of an `own` record in place (`s.a[i] := x`) can raise `aliased_update`; carry a Bool flag through the loop instead. Take `own` arguments from separate locals: `x := f x.field` on a record you also read later is `spent_value`/`own_argument`, so read what you need before the call. `a |> f` does not exist. An empty `#[]` in a record needs an annotated local (`let rows: #[~Row] = #[]`) first.

A `continue` placed right after rebinding an `own` local (`work := f work; continue`) loses that rebinding at the loop's back edge (`spent_value` at the next iteration's first use, or `own_argument`). Move the body into a helper that `return`s the successor, or set a flag and `continue` after the branch. A loop bound such as `for k in 0 .. work.order.length` holds `work` for the loop; copy the length into a local first. Reading a field of an `own` local in the result expression (`return (work, $R { cost: work.costs[g] })`) is `result_not_owned`: bind the scalar first. `import` lines must precede all declarations, and a type annotation is needed on empty `#[]` locals (`let a: #[~U32] = #[]`).

Blot has no `else if`: nest an `if` inside `else:` (the checker reports the
whole declaration as a grammar error). Vector methods are qualified through the
imported module, `vector.Vec3.dot`, not `Vec3.dot`. Rebinding a fresh array from
a callback result or another name needs `@storage.copy`; an `own` argument is
spent by the call, so pass `(@storage.copy x)` to keep reading it.
Parenthesize negative argument literals and bitwise-or array elements; use do
for statement-bearing case arms and nest block if inside else. Compare record
fields explicitly. Keep generated constant caches modest and build discardable
indices at runtime when constant evaluation cannot support them.

[Historical October compiler notes](historical/compiler-2026-10-notes.md) retain
measured inline/copy behavior, audit links and ratios for their exact versions.
They are not current performance/snapshot promises. Fresh measurements require a
qualified candidate and retained source/Wasm hashes.
