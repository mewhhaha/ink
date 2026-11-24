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

Quirks met while writing physics: a union variant and the constructor of a
record it wraps may share a name (`Shape.$Mesh` and `mesh.Mesh`): qualify the
record's as `$mesh.Mesh {...}`. `x.field := v` on a record read out of an array
element is `aliased_update`; write `values[i] := f self` through a helper that
takes and returns the record. A closure-captured array cannot go to an `own`
parameter: declare it inside the closure. A `func` value defined inside another
function may `return` early from its own body, so BVH visitors written as local
closures (`mesh.ray_hit`) can use ordinary control flow.

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

Maps are caller-owned `map.Map [key,value]` values created with `map.empty ()`
holding insertion-ordered rows and hash buckets together. Policies are known
hash/equality functions. `map.u32` preserves full-width keys; `map.text` reads
character views whose owners must outlive stored keys. F32 policies explicitly
define NaN/signed zero.

| Operation                                                        | Contract                                        |
| ---------------------------------------------------------------- | ----------------------------------------------- |
| `get policy key table`                                           | Optional lookup                                 |
| `set policy key value table`                                     | Insert/replace; retain first equivalent key     |
| `remove policy key table`                                        | Remove and return updated map                   |
| `from policy entries table`                                      | Ordered insertion; later duplicate values win   |
| `set_many`, `remove_many`, `edit_many`                           | Ordered edits returning the updated map         |
| `entries table`, `keys table`, `values table`                    | Independent arrays in surviving insertion order |
| `copy_into policy copy_key copy_value destination source`        | Explicit destination and payload policy         |
| `clear table`                                                    | Reset rows and buckets                          |

Removed rows are tombstones; enumeration scans inserted rows. Compact/reset
explicitly. Sets are Unit-valued maps (`set.Set k = map.Map [k, Unit]`), with
owned updates. `map/frozen.from equal entries` builds one fixed ordered
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

Handles tie opaque `Handle kind` to nominal `Store [kind,value]`, which owns
the payload, dense-owner IDs, slots, free slots and metadata as one caller-owned
value. This protects storage access, not merely the handle's annotation.

```blot
import * as handles from "ink/handles"

type Item is data = $Item
entry func item () : U32 => return do:
  let values: handles.Store [Item, U32] = handles.empty $Item 7 1 8
  let (found, values) = handles.insert $Item 42 values
  let $Some target = found else:
    return 0
  return Maybe.unwrap_or 0 (handles.get target values)
```

`handles.handle_pool kind` creates one named opaque-handle pool. Stale
generations and foreign region/origin are rejected. Dense swap-removal updates
the moved slot; serialization preserves U32 identities. Mutations take
`own Store` and return the updated store explicitly.

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
  let (id, alive, entity_meta) = ecs.spawn alive entity_meta
  let (values, value_meta) = ecs.insert alive values value_meta id 17
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

Static triangle meshes (`ink/mesh`) are finite, double-sided, world-space level
geometry: `shapes.cook_mesh geometry vertices indices` stores a vertex pool, a
seven-word record per triangle (corners, seam flags, edge neighbours), unit
planes and a BVH over triangle bounds in the existing point/plane/index/height
pools, and returns `Maybe mesh.Mesh`. Non-finite vertices, indices outside the
vertices, a length that is not a multiple of three and an empty result return
nothing; repeated, collinear and sliver triangles (width under 1e-5 of length)
are dropped and equal positions weld, so duplicated vertices still share edges.
`scene.level id mesh` is a static source; `$Mesh` colliders ignore rotation,
scale and rigid bodies like terrain, and are never solid inside (a thin sheet:
`point_solid` is false). Capsules and spheres use the closest-point gap, hulls a
separating-axis test per candidate triangle, rays an exact BVH traversal (casts
with a radius advance conservatively on the gap). Seams: an edge or vertex
contact on a triangle is active (a convex feature seen from the body's side),
smooth (neighbours within five degrees: the face normal and plane distance
replace the edge's) or concave (the neighbour's face covers it: dropped from
contacts); boundary and non-manifold edges are always active. Hull axes that
only touch a smooth or concave seam are rejected, so tessellated floors give the
same contacts as one plane. Contacts of one pair closer than the 0.15 m warm-start
radius merge, keeping the deepest, because the cache would otherwise hand each
one the same impulse; a mesh manifold keeps at most four. Cooking costs
O(n log n) and `scene.build_into` copies the cooked pools, so cook once, keep
the source in a prepared fixed world (`physics/prepared`) and report a changed
mesh source through `scene.update` (equal-sized pools are reused in place).
Prepared and rebuilt worlds are bit-identical on meshes.

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
pass per substep has no break threshold or warm-start cache. See
[physics](../examples/physics.blot), [steps](../examples/steps.blot) and
[joints](../examples/joints.blot).

Joint kinds: `distance`, `spring`, `hinge`, `ball`, `cone_twist`, `slider` and
`fixed`. `limit j lower upper` bounds hinge angle, ball twist about `axis_a`
(radians) or slider translation along it (metres); `cone_twist` adds a swing
half-angle. Angles are zero at `rest`, the relative rotation `conj(a) * b`
(`at_rest j rotation_a rotation_b` captures the current one). `motor j speed
torque` targets a velocity; `drive j target torque hertz zeta` is a soft
position spring and `pose_drive j rotation torque hertz zeta` drives a ball
joint's relative rotation. Limits are unilateral soft rows (60 Hz, damping ratio
2, speculative approach); motors are capped per substep by torque times h.
Each row is solved sequentially against the bodies' own inertia, so a position
drive is much softer than its hertz suggests on light limbs: raise `hertz`
(at most a quarter of the substep rate applies) and torque, and use 8 or more
substeps for chains. Invalid limits (lower above upper, angles beyond pi, swing
outside 0..pi), zero axes, zero rest rotations and nonfinite lanes are ignored.

`ragdoll` builds capsule bodies and cone-twist joints from an animation skeleton
(`parents`, local bind `Pose3`, U32 max roots). `default_bones parents bind
radius swing twist_low twist_high strength` makes per-bone settings (tails run to
the first child); `bodies id_base layer mask parents bind bones` returns dynamic
capsule sources (bone `i` is source `first + i`, entity `id_base + i`), and
`joint_list first parents bind bones` the cone-twist joints between them. Give
the ragdoll one layer and leave it out of its own mask: neighbouring capsules
overlap at every joint. `powered parents bones animated strength hertz zeta
links` retargets those joints to an animated local pose (strength scales each
bone's torque; zero relaxes it); `pose first parents bind bones sources` reads
animation-local poses back from simulated bodies (bone lengths keep the bind
pose; the root takes the world position) and `blend animated simulated weight
mask` mixes poses like `animation.blend`. Bone scales are ignored; invalid
skeletons give empty arrays.

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
`color.grade grade cdl table_a table_b light u v` is the colour grade Pen's present
pass applies, formula for formula: a vignette, exposure offset and white balance,
contrast about `pivot` in an ACEScc-like log encoding (`cc_encode_one`,
`cc_decode_one`), ASC CDL in linear light (slope `gain`, offset `lift`, power
1 / `gamma`), saturation and vibrance about the luminance, then up to two
look-up tables in log (`lut_lookup`, trilinear with texel centres at
i / (size - 1); the part of the encoding outside 0 to 1 passes through, so black
and highlights are not clipped). `color.neutral` is the identity, and
`Grade.lut_a` / `lut_b` name the host's tables by material (`color.table material`,
0 for none) while the Blot reference takes the tables themselves (`color.Table {size, texels}`, texel
(r, g, b) at ((g * size + b) * size + r) * 3). `color.histogram_bin`,
`trimmed_average`, `exposure_goal` and `adapt` are the metering and adaptation
steps of auto exposure (`render.Exposure`): a bin per 1/16 stop over the
histogram's range, the average of log2 luminance between two percentiles, the
stops that bring it to middle grey plus compensation within limits, and a step
that closes `1 - exp(-rate * dt)` of the distance at the brighten or darken
rate. `render.fixed_exposure` is the default (nothing changes) and
`render.auto_exposure` brightens over a third of a second and darkens over a
second; set `frame.settings[0].exposure`, `.grade` and `.cdl` in the render stage, as
every frame setting is (`render.begin_frame` resets them). The adapter fills
`exposure.dt` (the game's seconds, 0 while paused) and sets `exposure.cut` on the
first frame after `app.invalidate`; `app.control ()` has a fourth lane for that.
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

`shadow.splits near far count blend` cuts the camera's depth range into `count`
slices, nearest first, as the practical scheme: blend 0 is linear, 1 logarithmic,
the last split is exactly `far` and they strictly increase. A nonpositive or
nonfinite `near`, `far <= near`, a zero count or a nonfinite blend give an empty
array. `shadow.fit view projection direction count texels distance blend` fits
`count` sun cascades to a frame's camera (a rigid view matrix and
`Mat4.perspective` or an orthographic projection of `camera.lens`'s shape, either
depth direction; near and far come from the projection) and returns
`Maybe Fit {view: Mat4, cascades: #[Cascade {projection: Mat4, texel: F32, far: F32}]}`.
The slices run from the near plane (at least 0.01) to `min distance far`. A
cascade's window is a square around the smallest sphere holding its slice, with
that radius rounded up to a sixteenth and enlarged by `texels / (texels - 1)`,
and its centre is snapped to whole texels of the light's view: the radius and
`texel` depend only on the lens and the splits, so a camera that moves or turns
shifts a window by whole texels only (the translation lanes `wx`, `wy` are exact
multiples of `2 / texels`). All cascades share `view`, which looks along
`direction` from 1000 units back along it from the origin; a window's depth range
is its sphere's distance along the light plus or minus its radius and 60. Nothing
for a zero or nonfinite direction, an unusable camera, `texels < 2`, a count of
zero or over four, or no distance to cover. A perspective camera's far plane is read back from its
matrix to about `far / near * 6e-8` of itself.
`graphics.shadow frame texels` composes this with the player's tier
(`graphics.tier texels`: 0 none; 1024 two cascades, PCF, no contact, no local
casters; 2048 three cascades, PCSS, 12 contact steps, two local casters of 512;
4096 four cascades, PCSS, 20 steps, four casters of 1024) and the frame's
`render.ShadowSettings {distance 80, softness 0.04, contact_length 0.5}`
(`frame.shadow`, reset by `render.begin_frame`). It returns `graphics.Shadow`
(`view`, `texels`, `filter`, `softness`, `contact`, `contact_length`, `local`,
`local_texels`, `cascades`), all zero with no cascades when the tier is off or the
camera or light cannot be fitted, such as a frame that sets no view or projection.

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

Local reflection probes: `render.ReflectionProbe {id, revision, priority,
capture, position, centre, extent, blend, parallax_centre, parallax_extent,
far}` names a box of the world (`centre`, half size `extent`) whose glossy
surfaces reflect a cube the host draws from `position` with the frame's own
opaque draws, sun, shadows and lights over the sky. Publish them as
`settings.reflection_probes := $Some ($render.ReflectionProbes {list})` over an
owner the game keeps (at most 64; the host keeps 8 cubes, `reflections.choose`
says which). The host draws a cube when its probe has none, when `revision`
changes (bump it when the room changes) or when `capture` rises, at most
`settings.reflection_budget` faces a frame (6 make a cube; 2 by default), over
as many frames as that takes, never while assets load; the old cube is used
until the new one is whole. The influence box must contain the surfaces that
should reflect it: a floor lying on a face of the box is outside it. Inside the
box the probe fades in over `blend` metres. Boxes that overlap give the surface
to the higher `priority` first, and equal priorities blend by weight
(`reflections.influence`, `shares`, `coverage`: each probe's weight is the
smoothstep of the distance in from the nearest face over `blend`; at most four
count; the shares add up to the coverage, and the sky has the rest).
`parallax_centre` and `parallax_extent` are the box of the room the cube was
drawn in: the lookup direction becomes where the reflected ray leaves it, seen
from `position` (`reflections.box_projected`); any half size of 0 or less looks
the cube up at infinity. `room_probe id revision centre half` makes the usual
one. The host scales a cube by how the diffuse probe lattice's (or the sky's)
mean light at the probe has changed since it was drawn, within a factor of four,
so one drawn under other light does not glow; the sun and the lights it
captured stay as captured, so raise `revision` when they change much.
`settings.screen_reflections` (0 off, 1 low, 2 high; 2 by default) asks for
screen-space reflections, capped by the player's `Quality.reflections`
(preference lane 14: 0 off, 1 low, 2 high). With no probes and no
screen-space reflections a frame shows the sky's reflection alone, as before;
they march the depth of casting materials in the picture, read last frame's
resolved picture, need a perspective camera, and make Pen turn temporal
antialiasing on. Pen's `ARCHITECTURE.md` has the details and limits.

Fog and volumetrics: `render.Fog {radius, density, height, edge, distance,
albedo, anisotropy, sun, ambient, sky, noise, noise_scale, drift}` is the
global medium (`settings.fog`, reset by `render.begin_frame`): extinction
`density` per world unit that falls off with height above y = 0 over `height`,
cleared inside `radius` of the vertical axis through the origin (rising to full
over `edge` past it), varied by `noise` (0 to 1) of a 3D noise whose coarsest
cell is `noise_scale` and which the game carries by `drift` (wind times time).
`distance` is how far ahead of the camera, along the view, the froxel volume
reaches; beyond it the mist is analytic, and 0 draws no volume at all. `albedo`
is the share of light scattered, `anisotropy` the Henyey-Greenstein g (-0.95
to 0.95: positive gives shafts toward the sun), `sun` and `ambient` scale those
lights' in-scattering and `sky` blends the ambient toward the sky's own colour
(1 fades distant objects into the sky). Publish up to 32 local volumes as
`settings.fog_volumes := $Some ($render.FogVolumes {list})` over an owner the
game keeps: `FogVolume {shape, centre, extent, density, albedo, emission,
falloff}` is a box (shape 0) or ellipsoid (1) of half sizes `extent` whose
medium adds to the mist's inside it, rising over `falloff` of the half size in
from its edge; `emission` is radiance per unit of density. `settings.volumetrics`
(0 off, 1 low, 2 high; 2 by default) is the scene's tier, capped by the player's
`Quality.volumetrics` (preference lane 15; `Quality.fog` stays the density
scale, 0 to 2). The tiers are `volumetrics.grid tier`: low 80 x 45 froxels,
32 slices, one sun-shadow tap, two noise octaves; high 160 x 90, 64, sixteen
taps, three. `ink/volumetrics` is the reference Pen's shaders are held to:
`boundary_depth distance slices b` slices by depth along the view,
`knee * (exp (b / N * ln 65) - 1)` with `knee = distance / 64`, and
`boundary_coordinate` inverts it; `medium_at fog volumes octaves p` gives the
extinction, the scattering by channel and the emission at a point
(`global_density`, `noise_factor`, `local_weight`); `height_optical_depth`
integrates the mist along a segment in closed form (exact above y = 0, as the
host's analytic fog uses it); `phase_scaled g c` is pi times the Henyey-Greenstein
phase function (`phase_hg` integrates to 1 over the sphere), `scatter_source`
adds a froxel's `scattering * (sun + ambient + lights) + emitted`;
`integrate_column slices` integrates a column front to back (`light += T *
source * (1 - exp(-sigma delta)) / sigma`, `T *= exp(-sigma delta)`) into the
light and optical depth at each boundary, `apply scene light tau` attenuates
the scene by `exp(-tau)` and adds the light, and `history_weight`,
`blend_history` are the temporal blend (the history counts for less as the
extinction changed). `noise.value3 seed p` and `noise.fbm_value3 seed octaves p`
are the 3D value noise and its fractal sum (octave i uses `seed + 101 i`, twice
the frequency and half the strength), written so a shader can repeat them.
`render.set_fog fog settings` writes the frame's fog (below). Blot has no
native `exp` or `ln`: `volumetrics.exp` reduces by whole powers of two before a
series, so it holds F32 to a few ulps where `color.exp2` alone is off by up to
2e-6 near a half, and `volumetrics.ln` is `color.log2` scaled. A slice's
`1 - exp(-sigma delta)` is evaluated by its series below 0.01, because the plain
subtraction cancels (the host's shader does not, so very thin media are noisier
there than here; below `sigma` of 1e-6 both add `source * delta`).

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

`render.PointLight {position, radius, intensity, direction, inner, outer, shadow, id}`
is a point light when `outer` is -1.0 and a spot light otherwise (`inner` and
`outer` are cosines; `direction` is a unit vector). `render.point_light position
radius intensity` and `render.spot_light position direction radius intensity inner
outer` (half-angles in radians) build them without shadows; set `shadow` and a
stable, distinct `id` to ask the host to cast shadows from a light. The host admits
the player's allowance of them, nearest first, `id` breaking ties.

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

## Surface lobes

**Known divergence from Pen's WGSL base lobe.** Pen's shipped shaders (and so
Gdev's frames) light diffuse as `albedo * (1 - metallic) * radiance * nl` with no
`(1 - F)` factor, and a back-facing view still receives diffuse; `lighting.brdf`
weights diffuse by `(1 - F)` and returns nothing for a back-facing view. Pen
keeps its model so that existing frames do not change; the GPU tests therefore
compare the specular and every optional lobe against this module and the f64
reference, and pin the diffuse difference explicitly (docs/materials.md, "The
standard surface"). Ambient sheen is `tint * Es * irradiance` in Pen and has no
Ink counterpart; ambient transmission is `tr * behind * base * (1 - Fspec) *
(1 - metallic)`; the cheap subsurface's back-lit term goes into the specular sum
there.

`lighting.Material` is the base: `base`, `metallic`, `roughness`, `emission` and
what sets its face-on reflectance, `ior`, `specular` and `specular_color`
(1.5, 1 and white are the glTF default and give `f0 = 0.04` exactly). A
`lighting.Surface` adds optional groups, each off at weight 0 and then costing
nothing: `Coat` (weight, roughness), `Sheen` (colour, roughness), `Anisotropy`
(strength in [-1, 1], rotation), `Transmission` (weight, thickness,
attenuation colour and distance) and `Subsurface` (amount, colour, thin). A
`Frame` holds the shading normal, the geometric `coat_normal` (a zero vector
means the shading normal), the mesh tangent and its handedness, and the unit view
toward the eye. `lighting.plain material` is a surface with no group on, and
`surface_response surface frame light` is `brdf` exactly for it (not nearly:
bit for bit). `shade_surface` scales the response by a sample's radiance.
Every response is per unit radiance with NoL included. Pen's lights are scaled
so that a diffuse surface is albedo times colour times the cosine; its
specular terms are therefore multiplied by pi, as `cluster_light_response`
does. Pen's WGSL surface library follows the rules below, and
`tools/native/src/surface.rs` holds this module to an independent f64
reference of each. The Ink core shaders in `shaders/` do not use any of it.

Base: `r = clamp(roughness, 0.04, 1)`, `alpha = r^2`, GGX with `a2 = alpha^2`,
height-correlated Smith visibility floored at 1e-6 in its denominator. The
dielectric `f0 = min(((ior - 1) / (ior + 1))^2 * specular_color, 1) * specular`
per channel with `ior` at least 1, evaluated as `(ior - 1)^2 / (ior + 1)^2` (two
products and one division) so that 1.5 is the F32 nearest 0.04; `f0` runs to the
base colour with `metallic`, `f90 = mix(specular, 1, metallic)` and
`F = f0 + (f90 - f0) (1 - vh)^5`. `specular` is not clamped: keep it in [0, 1].
A back-facing view (`n . v <= 0`) and a zero light vector shade nothing; a
light behind the surface (`n . l <= 0`) zeroes the specular and sheen lobes
(and one behind the coat normal the coat), and leaves only the diffuse lobe's
subsurface terms.

Layering, per channel, with `tr` the transmission weight: `base = (diffuse *
(1 - tr) + specular) * sheen_keep * coat_keep`, `result = base + sheen +
coat`. The sheen is not dimmed by the coat (the contract's `base_lobes` are the
diffuse and specular lobes), and the back light below belongs to the diffuse
lobe. Weights clamp to [0, 1].

- Coat: coat roughness `rc` clamped like `r`, `ac = rc^2`, `ac2 = ac^2`, GGX of
  `ac2` at `nhc = saturate(nc . h)`, and the base lobe's height-correlated Smith
  visibility at the coat's alpha and normal, `V = 0.5 / max(1e-6, nlc
  sqrt(nvc^2 (1 - ac2) + ac2) + nvc sqrt(nlc^2 (1 - ac2) + ac2))` with `nlc =
  saturate(nc . l)` and `nvc = max(1e-5, nc . v)`. The coat's own response is
  `coat = w Fc(vh) D V nlc` with `Fc(vh) = 0.04 + 0.96 (1 - vh)^5` from the half
  vector's angle to the view. What the layers below keep (diffuse and specular,
  and the back light) is `coat_keep = 1 - w Fc(nvc)` with `Fc(nvc) = 0.04 + 0.96
  (1 - clamp(nvc, 1e-5, 1))^5`: the coat's Fresnel at the view, the same for
  every light. `coat_response` returns the pair; `coat_ibl` gives `w (0.04
  split_x + split_y)` and the same `1 - w Fc(nvc)` for the coat normal's view
  cosine. Energy: the coat's own albedo is a GGX lobe's, at most 0.90 over view
  cosines down to 0.02 and roughness 0.04 to 1 at full weight. The uncoated base
  already has an albedo above 1 at grazing views (1.84 at a cosine of 0.02 with
  roughness 0.04, 1.23 with 0.4: its Lambert lobe gives up `1 - F(vh)` per light
  while its specular lobe reflects `F` of the view's angle), so the layered
  albedo is bounded by `max(1, uncoated base) + 1e-3` (at most 7e-4 over it on
  the tested grid of view cosines 0.02 to 1, coat roughness 0.04 to 1, base
  roughness 0.1, 0.4 and 1), not by 1: it reaches 1.21 at a cosine of 0.1 with
  both roughnesses at their least, where the uncoated base is 1.55.
- Sheen: roughness clamped to [0.07, 1], `as = rs^2`, `Ds = (2 + 1/as)
  (1 - nh^2)^(0.5/as) / 2 pi`, `Vs = 1 / (4 (nl + nv - nl nv))`, `sheen = s Ds Vs
  nl`, `sheen_keep = max(0, 1 - max(s) * sheen_albedo(nv, rs))`. `sheen_albedo` is
  the integral of `Ds Vs nl` over the hemisphere, capped at 1 (it is higher at
  grazing views with low roughness), as a 32 x 16 bilinear table: columns
  evenly spaced in `sqrt(nv)`, rows in `sqrt((rs - 0.07) / 0.93)`, entry
  `32 row + column`, arguments clamped. The table at the end of `lighting.blot` is
  generated by `tools/native/src/surface.rs` (`INK_WRITE_SHEEN_TABLE=1 pen
  test-blot --filter sheen_table` rewrites it; the test fails if the file
  differs) from a 256 x 256 midpoint quadrature, and is within 0.006 of the exact
  integral. A white base under a white sheen stays within that error of 1, or of its own albedo.
- Anisotropy: `a` clamped to [-1, 1], `at = mix(alpha, 1, a^2)`, `ab = alpha`, the
  distribution and visibility of the contract with the visibility's denominator
  floored at 1e-6 like the isotropic one. The tangent is the mesh tangent made
  perpendicular to the normal; one that is missing or along the normal becomes
  the unit cross product of the normal and the coordinate axis it is least along
  (Blot has no derivatives to derive one from). It turns about the normal by
  `rotation` (`t cos + (n x t) sin`) and `b = (n x t) * handedness`. A strength
  of exactly 0 takes the isotropic path (`aniso_response` forces the anisotropic
  formulas and agrees with it to better than 1e-4 relative at 0). `bent_normal` and
  `aniso_reflection` give the image-based direction; the bent normal is the shading
  normal where the mix vanishes.
- Subsurface: the diffuse lobe's Lambert factor `nl` becomes `(1 - s) max(x, 0) +
  s wrap(x, 0.5) saturate(sc + max(x, 0))` with `x = n . l` unclamped and
  `wrap(x, w) = saturate((x + w) / (1 + w)^2)`, inside the same `base (1 - F)
  (1 - metallic) / pi`. The back light `s sc (1 - thin) back base / pi 2` has
  `back = saturate(v . -normalize(l + 0.2 n))^4`, computed as two squares, and
  neither `(1 - F)` nor `(1 - metallic)`. With a white tint the diffuse lobe
  integrates to 1 over the sphere for any amount.
- Transmission: `refract` is GLSL's (zero vector at total internal
  reflection); `transmission_ray` refracts the negated view by `1 / max(1, ior)`;
  `volume_exit` adds `thickness_world` (the material's thickness times the model's
  scale, supplied by the caller) along it; a thin-walled surface (thickness 0)
  exits where it entered. `volume_attenuation` is `color^(thickness_world /
  distance)` per channel and white for a distance or thickness of 0 or less.
  `transmission_level` is `min(last, log2(width) * clamp(r * clamp(2 ior - 2, 0,
  1), 0, 1))`. `transmit` returns `tr * behind * base * attenuation * (1 -
  Fspec) * (1 - metallic)` with `Fspec = f0 split_x + split_y` and no clamp;
  the caller reads `behind` and the table. Punctual lights get none of it.
- Parallax: heights are in [0, 1] (1 the surface) and clamped; the view and light
  are unit tangent-space directions. The layer count is `N = floor(mix(32, 8,
  |z|))` with `mix(a, b, t) = a + (b - a) t` in F32 and `|z|` at most 1, that is
  `floor(32 - 24 |z|)`: 8 for a view along the normal, 32 across it. The steep
  search samples layers `k = 0 ..= N` at `uv + k step` with `step = (-view.xy / max(z,
  1e-4)) * scale / N` and ray height `1 - k / N` (computed as `f32(k) / f32(N)`),
  stopping at the first layer whose sampled height is at or above the ray
  height (the sample the ray has gone under; layer N always qualifies); the one
  linear refinement blends it with the layer before it by `w = gap / (gap -
  previous_gap)` (`gap = sampled - ray`, `result = hit + (before - hit) w`). A
  hit at layer 0 or a view with `z <= 0` leaves the coordinates alone. The
  self-shadow starts at the displaced point's height `h` and marches `k = 1 ..=
  N` (N from the light's `z`) along `light.xy / max(z, 1e-4) * scale * (1 - h) *
  k / N` rising from `h` to 1; `shadow = 1 - saturate(8 * max(0, most any sample
  stands above the ray))`, and 0 for a light with `z <= 0`. `grid_height` reads a
  height texture's red channel bilinearly at texel centres with repeat
  addressing. Parallax takes any `F32 -> F32 -> F32` height function.

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

A module's own `private func wrap` silently shadows the prelude's `wrap period value` when the shapes agree: a later `wrap w x` in the module calls the private one with no diagnostic (the subsurface kernel's `wrap` once turned `grid_height`'s addressing into garbage); name private helpers apart from prelude functions (`wrap`, `lerp`, `clamp`, `saturate`, ...). `min a b` is `if a < b then a else b` and `max` likewise, so a NaN first argument gives the second and a NaN second argument gives the NaN: `min nan 1.0` is 1 (`min (ratio * tint) 1.0` turns a NaN index of refraction into a perfect mirror's `f0`) while `clamp` and `saturate`, whose NaN is the second argument of both, pass it through. Test NaN only for inputs that must propagate (geometry), and write `if length <= eps: <fallback> else: <normalize>` so a NaN falls into the normalizing branch. `pen test-blot tests/x.blot` does not compile a module that has no `test_` entries; compile it through a Rust `Fixture` (`tools/native`) to see diagnostics, which carry byte offsets only. Closures passed as `F32 -> F32 -> F32` parameters, six-element tuple results, thirteen curried scalars and `:=` on names destructured from tuples inside `if`/`else` all compile.

`math.Vec3` is not a type (`Vec3` comes from `std/vector`); the diagnostic is the cryptic `unsupported_type: This annotation type is not implemented in the native compiler`. A module with an `entry func` cannot be imported by another test (`entry_module`): keep shared test helpers, such as `tests/shadow_support.blot`, free of entries.

Assigning a record of more than about sixteen scalar lanes into a field of an
array element (`settings[0].grade := g`) is `storage_unsupported: update of a boxed
field inside an element`, whether its lanes are scalars, `Vec3`s or `U32`s; fewer
(`Clouds`, `Lighting`, 15 lanes) compile. `color.Grade` and `color.Cdl` are two
records for that reason, as `render.Settings.grade` and `.cdl`.

The limit is 16 scalar lanes: a 16-lane record assigns into an element's field and
a 17-lane one is `storage_unsupported` (checked with plain F32 records). `render.Fog`
has 17 (five scalars, three albedo lanes, four light and sky scales, the noise's
amount and scale, the drift's three), so `access.frame.settings[0].fog := fog` no
longer compiles. Write the fields (`settings[0].fog.density := ...` works), or
`access.frame.settings := render.set_fog fog self`, which reads the row, replaces the
field and writes the row back (the whole `Settings` row assigns fine). Where `access`
has no known type yet (a `draw (own access)` that nothing annotates) that update is
`ambiguous_operator: Unresolved update requirement`: use `access.frame := render.prepare_fog
fog self`, the same on a typed frame. Splitting the
record, as `Grade` and `Cdl` were, would have changed the wire-mirroring shape.

Writing `access.frame.settings[0].exposure.dt := ...` after binding aliases of
other fields of `access` (`let control: Control = access.control`) is
`aliased_update`, in a function that goes on to use `access`: read what you need
as a scalar (`let seconds = if app.paused access.control then 0.0 else
access.wall[0].seconds`) and write after, or the later field writes see the earlier
borrows. A `$Some x` argument of a curried call needs its own parentheses
(`color.grade g ($Some first) other ...`). `case` on a `Maybe` is a fine way to
return a computed value but not to mutate `let` locals in its arms; pull the
arm's work into a helper that returns the successor (`color.grade_tables`) or
`let $Some first = a else:` and return early.

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
