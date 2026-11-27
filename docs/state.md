# Application state mechanisms

These modules keep identities, cached calculations and behavior progress in
caller-owned Squid values. Their fixtures use building, staffing and delivery
vocabulary; the library does not. See `tests/handles.sq`,
`tests/derived.sq`, `tests/codec.sq` and `tests/behavior.sq` for complete
integrations.

## Stable handles

`handles.empty kind region origin capacity` (or `handles.store` with caller-named
pools) creates an empty store. Use a distinct nominal kind for each object
category, for example `type Building is data = $Building`. `Handle Building`
cannot address `Store [Pile, value]`. Both handles and stores are opaque; use
`get`, `set`, `insert`, `remove`, `handle_at`, `values` and `count`. Operations
that can fail return `Maybe` or a `(Bool, Store)` pair. Mutating operations
(`insert`, `set`, `remove`, `decode`) take `own Store` and return the updated
store; copy the store explicitly when an earlier snapshot must be retained.

A handle contains four U32s: region, birth origin, slot and generation. The
caller must allocate unique region ids for independent stores, and fresh origin
ids before allocating in divergent histories. Never reuse an origin within a
region while handles from that history can remain observable, including after a
restore. For unrelated restores, allocate a new region and explicitly migrate
references instead of retaining their old identity.

Lookup is constant-time indirection. Iteration follows dense order; removal
swaps the last value into the hole. The moved value keeps its handle. Free slots
are reused last-in-first-out. A removed slot increments its generation; at U32
maximum it retires permanently. Capacity counts allocated slots, including
retired ones. No operation scans the application's references.

`encode_handle` uses four exact U32 words; `decode_handle kind` reconstructs
them without asserting that they resolve. Version-1 `encode encode_value store`
saves region, origin, capacity, slots, dense owners, free order and framed
values. `decode kind decode_value words destination` validates their indirection
and framing before overwriting `destination`. A round trip preserves future
allocation order and object identity.

## Checked derivation and persistence

Describe generation jobs in JSON and run:

```sh
pen tool ink -- generate tools/generate.json
pen tool ink -- generate tools/generate.json --write
```

The default checks without writing. A `codec` job supplies `source`, `schema`,
`output` and optionally a previously published layout as `published`. A separate
`manifest` path can receive the next layout; the published baseline is never
rewritten. Input and output must be distinct files in the same directory.
Applications import the generated module, which includes the checked model.
See `tools/generate.json` in the full repository and [testing](testing.md).
These development tools are excluded from the source distribution.

Each generated `name_codec migrate` factory applies its metadata key, version
and capacity; `name_descriptor` exposes its semantic fields. The caller supplies
the migration function, including `codec.no_migration` when appropriate.

The tool checks the complete model with Pen's native compiler, extracts opted-in
data declaration shapes and checks the emitted source again. Its small structural
scanner handles records, products, scalar and nullary variants, comments and
balanced delimiters; it does not replace the compiler's syntax/type checking.
Unsupported shapes fail rather than inferring a layout. The Rust emitter
allocates each record's output once and uses a bounded decoding cursor. Scalar
specialization preserves exact U32 values, strict booleans and finite IEEE bits.
Metadata explicitly assigns section keys, type versions, variant tags and
field ids. Source field reordering preserves encoding; labels are inspection
metadata. Duplicate ids, stale output, changed section keys, decreasing
versions, and changed layouts without a version bump are rejected. Recursive
derivation requires a handwritten codec. For collections of user types, use
record fields such as `$Batch { sites: Array Site }`; parenthesized positional
collection types are outside this qualified generator path. Unsupported source
types remain native checker/generator errors, never a guessed layout.

`ink/codec.Codec` has the upstream `encode`/`decode` contract and framed U32
representation. Ink owns this equivalent contract because Squid's orphan rule
forbids implementing `std/codec.Codec F32` in Ink. The native generator is
bound to the Ink contract. U32 uses every bit, Bool accepts only 0/1, and F32
stores its IEEE bits, preserving signed zero and subnormals while rejecting
infinities and NaNs. Custom types implement this contract to validate
application invariants; the fixture's `Positive` rejects zero. Nested
Site/Delivery arrays round-trip.

`bridge key version capacity encode decode migrate` creates `lanes.Codec` for
existing `persist` registrations. Adapter format 1 stores the word count and
each word as two exact F32 halves, low then high. A numeric U32-to-F32 cast is
never used for word values. Capacity zero uses variable width for resources. A
positive capacity pads to `2 + 2*capacity` lanes for components and rejects
overflow; nonzero padding and malformed halves are rejected. This costs space:
the seven field Site encodes 24 words, or 50 variable lanes; a 32-word component
capacity uses 66 lanes, compared with the old seven-lane handwritten codec. The
latter cannot preserve arbitrary U32s. Keep handwritten codecs when this
overhead is unacceptable.

A migration receives old U32 words independently of their old padding width. It
must explicitly validate the old version and produce the new format. Increment
the type version for layout changes; increment the application's outer save
schema only when its outer format changes. Tests preserve the old snapshot while
migrating and register generated codecs as resources and snapshotted components.

Generated descriptors expose labels, declared types, stable ids and primitive
kinds. `inspect descriptor decode words` first validates the whole value and
then returns the typed value plus semantic fields. Nested/custom fields retain
their validated encoded words for caller-selected recursive inspection.
`changed` returns changed stable field ids; compare variant tags separately,
including nullary variants and removed fields. Inspection owns no UI.

## Derived resources

A `Source value` represents a semantic channel, such as employment, completed
building membership or terrain geometry. Use `source key value clock`,
`replace`, and `replace_equal` at the corresponding write boundary. Changing
position or animation does not change an employment channel. Replacing an older
immutable value issues a new stamp. Do not modify source stamps or values
directly, or rewind clocks while retaining cache entries.

`evaluate clock dependencies compute cache` accepts a pure `Unit -> value`
callback and returns the updated clock, cache and result. The caller supplies
all relevant dependencies, sorted by unique key, and captures their current
values in the callback. This is explicit dependency declaration, not automatic
read-set tracking. ECS effects in the callback fail compilation. Read ECS values
at the system boundary; store the returned clock/cache in the explicit world.
The staffing fixture checks unrelated motion, no-op capacity edits,
selected-field edits, insertion/removal and snapshot retention against full
recomputation.

Validation visits only the declared dependency stamps, O(D), with no component
scan or deep hash. Write-side invalidation issues one stamp per changed semantic
channel; equality checks are caller-selected and may have their own cost.
`result_dependency` chains cached results. Evaluate upstream nodes first;
`order` validates an explicit graph and rejects cycles and invalid indices.
Conditional computations supply the dependencies of their current branch.

A stamp is a region, origin and sequence. Use a unique region for each unrelated
cache/world lifetime and `fork` with a fresh caller-allocated origin for
divergent histories. Never reuse region/origin pairs while their stamps can be
observed. Sequence exhaustion traps instead of wrapping. Restore caches cold
under a fresh region, or retain a complete coherent world/clock/cache snapshot
and fork before new writes. Equal counters in another region never reuse
results.

Each cache retains one result and at most its explicit dependency capacity.
Applications bound the number of caches and size of their result values.
Eviction clears only cached data; counters report computes/hits, and causes
identify the first changed dependency or a changed dependency set/region.
Eviction changes cost, not results. Tests cover old terrain replacement,
unrelated restores, branches, transitive dependencies, conditional dependencies
and exhaustion.

`ink/derived/keyed` provides the local full-key memoization helper separately:
`read equal key cache`, `keep key value` and `resolve equal build key cache`.
The caller supplies a complete key and equality; comparing array keys scans the
key. These caches restore cold. Its local revision pair is a caller-managed key,
not a substitute for `derived` region/origin identities across unrelated worlds.

## Logical-time behaviors

`behavior.build version entry nodes` sorts stable step ids and validates unique
ids, targets, wait durations and repeat owners. `action`, `wait`, `until`,
`branch`, `repeat`, `again` and `stop` construct ordinary typed nodes. `start`
creates explicit state containing version, step, elapsed seconds, local data,
repeat frames and status. Application actions/conditions are nominal data;
callbacks are pure and receive explicit inputs.

`advance program state seconds budget max_frames act ready cleanup` dispatches
at most `budget` nodes. Waits consume logical seconds and carry surplus to
subsequent steps. Completed actions return unused time; pending actions consume
the tick and supply an inspectable reason. Conditions use current caller data.
Zero budget performs no work. Immediate loops stop with `Budget`; repeat stack
capacity stops with `StackFull`. Both preserve remaining seconds for the caller
to carry or discard. A zero timestep can still dispatch immediate nodes: pause
by not stepping or by passing zero budget. No callback reads wall time.

`interrupt reason cleanup` invokes cleanup once, clears repeat frames and leaves
terminal state unchanged on subsequent calls. An action can `Abort` with the
same behavior. The delivery fixture resolves a typed pile handle on every action
and uses an explicit abort fallback after target removal; recycling the slot
never redirects it. Actor removal must call interruption before discarding its
state if cleanup is required.

`encode encode_local` uses U32 format 1;
`restore program max_frames decode_local` checks framing, program version, step,
finite elapsed time, repeat counts and waiting-state compatibility. The
application supplies the local codec; the lossless word adapter can carry the
result through Ink persistence. State fields and program nodes remain ordinary
inspectable data. Only states produced by the mechanism or validated application
migrations should be stepped; arbitrary forged control stacks are not a
supported program API.

Saving does not serialize closures or a Wasm stack. Stable ids let an authored
migration map old steps and local values, but a program edit does not implicitly
preserve progress. The fixture explicitly migrates a wait from version 1 to 2.
The scalar-local example saves nine U32 words plus two per repeat frame (36
bytes plus 8 per frame before any adapter), independent of crowd size.
Reference-machine traces cover every transition boundary, waits, large/zero
deltas, interruption, missing targets, repetition and exhausted budgets.

## Qualification

### Cross-frame work and service types

`task_queue` keeps ordinary request, result and continuation values in a bounded
world-owned queue. Supply a fresh nonzero epoch for every unrelated world or
restore. `submit tick earliest request continuation queue` returns a ticket;
`settle tick ticket outcome queue` accepts a completion once. Unknown, duplicate
and old-epoch answers are rejected. `publish tick queue` releases the ready
prefix in submission order, never before each job's earliest tick. A slow first
job deliberately holds later results. Completion events and their ticks must be
recorded for replay: ordering alone cannot make wall-clock arrival
deterministic.

`submit_many tick earliest requests continuations queue` returns
`Maybe (Queue, Array Ticket)`. It accepts the whole batch or leaves the queue
unchanged, and preserves the ticket and trace order of sequential submissions.
Request and continuation counts must match. Capacity, tick and ticket exhaustion
checks apply to the entire batch; the last U32 ticket is usable, then submissions
are exhausted. An empty matching batch succeeds without changing even a closed
or exhausted queue. Submission concatenates the existing jobs and new batch once.

`cancel` replaces an unpublished outcome with cancellation, while `close`
cancels the lifetime and refuses further submissions and completions. A closed
queue can still publish its cancellations. `reissue fresh_epoch queue` changes
ticket identity while retaining requests and already accepted results; issue
only its `pending` requests again. Transports with side effects require a saved
application idempotency key. Reissuing an HTTP mutation is not automatically
safe.

`encode`/`decode` take domain encoders/decoders for requests, results and
explicit continuations. They preserve accepted results, validate exact framing,
ticket order, capacities and temporal constraints, and omit transient trace
history. The queue bounds jobs at 4,096 and optional history at 256 marks;
applications must also bound each payload. History records submission,
completion, rejection, publication, cancellation and reissue. This is
logical-time work bookkeeping, not serialization of closures or suspended task
stacks.

Encoding, decoding and ready-prefix publication build their output arrays once;
close and reissue rebuild the jobs once. Queue framing and publication order are
unchanged. Domain encoders/decoders and optional bounded trace recording add
their own work; these operations do not make individual `submit` or `settle`
calls into bulk edits.

`services/typed.Method [input, output]` binds the application's service and
operation to a pure argument encoder and answer decoder. `ask` returns a
`Pending output`; `take` consumes it and distinguishes `Received` from
`Invalid`. `id` and `restored method id` bridge the existing saved request ID.
Methods are program definitions, not saved values. This wrapper uses the
ordinary recorded service protocol and its retry policy; it does not add native
async callbacks.

### Access plans

`schedule.plan width nodes` produces deterministic waves from explicit read and
write channels plus prerequisite node indices. It preserves source order across
write/write and read/write hazards. `Ordered` and `Unknown` nodes are full
barriers; cycles, invalid dependencies, widths over 32 and plans over 1,024
nodes are rejected. Pure work reads a snapshot and returns a delta, committed in
source order. The planner neither infers compiler effects nor starts threads.
Declaring a side effect pure does not make concurrent access safe. Tests compare
planned execution with serial execution across changing hazards.

`pen tool ink -- bench` measures the four modules at 64, 256 and 1,024 objects, with
independent witnesses, replay and guest memory growth checks. Handle workloads
cover lookup, dense iteration and churn while retaining an old snapshot,
including dense-index baselines. Staffing compares 32 cached evaluations against
32 full scans. Codec benchmarks compare the derived adapter with a handwritten
seven-lane baseline; behavior dispatch has an explicit state-machine baseline.
Results live in `.cache/bench-library-native.json` with compiler, machine and
source fingerprints.

## Native word saves

`ink/persist/words` carries `Array U32` directly through the guest's U32 ABI.
Construct `codec.saved key version encode decode migrate`, or use generated
`name_words migrate`. Encode sections with `write_alive`, `write_resource`,
`write_snapshotted_resource`, `write_component` and `write_snapshotted_component`
inside an `encode_state` / `encode_scene` schema callback, and restore with
`restore_alive`, `restore_resource`, `restore_component` and `decode_state` /
`decode_scene` into caller-owned pools. `tests/word-persist.sq` is a complete
example. Hosts copy the returned `Uint32Array` bytes; numeric conversion to
`Float32Array` loses integer bits.

This format uses `[magic, schema, section_count]`, followed by
`[key, version, word_count, payload...]`. State magic is 1229867863; scene magic
is 1229867859. Key zero stores alive flags. Component payloads store slot count,
present count, then ascending `[slot, length, payload...]` records. Snapshots
store `[current_length, current..., previous...]`. Schema, keys and versions are
full U32 values. Missing or incompatible resources use their registered initial
values; missing/incompatible columns become empty. Outcomes retain U32 keys and
versions. Invalid framing, duplicate sections/slots, dead components and invalid
values trap before the caller can accept the returned world. Scenes replace
entities and current components, copy those into previous components, and
preserve runtime resources. Old worlds remain usable.

Primitive-only derived variants now encode into one fixed array and decode known
offsets. Their field IDs, framing and strict Bool/finite-F32 checks match the
generic generator. Custom and nested codecs retain their implementations. The
existing `name_codec` factory still supplies the F32 host adapter. Pen's current
state-command interface uses that adapter; it already retains guest state
between frames. Native word persistence is an alternative boundary for
applications whose hosts accept U32 buffers, not a change to Pen's state ABI.

## Compiled authored behaviors

A `behavior` generation job compiles a caller-authored JSON graph into direct
Squid branches. It supplies `source`, `graph`, `output`, a `prefix` importing
`ink/behavior` as `_behavior`, and an optional checked `entry`. Add `selector: true`
to emit a one-shot selector too. The native compiler checks the callbacks and
result. Use the same `pen tool ink -- generate CONFIG.json [--write]` command.

The manifest names the graph, version, entry ID, local/
action/condition types and pure `act`, `ready`, `cleanup` callbacks. Nodes use
`act`, `delay`, `until`, `choose`, `repeat`, `again` and `stop`; the checked
fixture shows each shape. Action/condition expressions are trusted source.
Qualified type/binding names are supported; bind complex types to a source name.

The output exports `name_program` for inspection, start and restore, and
`name_advance state seconds budget max_frames`. State, Advanced, full visited
traces, budgets, action waiting/abort, stack limits and logical-time semantics
are unchanged. Save/restore and interruption use ordinary `behavior` functions.
Changing authored IDs or graph version needs an explicit application migration.
This specializes a static graph and its callbacks; runtime-edited graphs use
`behavior.advance`. Generation remains development tooling outside the package.

For a one-shot decision, `selector: true` emits `name_select local`,
which returns the chosen action without executing it. Its reachable graph must
be acyclic choices ending in exactly one action followed by stop. It rejects
waits, loops, action sequences, more than 1,024 nodes or paths longer than 64
decisions. Shared branches generate shared helpers instead of duplicating the
whole subtree. Only the selected branch evaluates its conditions.

This selector has no saved progress, time budget or visited trace. Use the
ordinary compiled behavior when those semantics are needed. Game measurements
still need to include callback and record costs: removing the progress machinery
does not guarantee a selector beats a short handwritten branch.

## Pure preparation graphs

A `dataflow` generation job compiles a small JSON dataflow description with typed
input/output, named pure calls and result references. Nodes may be declared in
any order; the compiler emits stable dependency waves as ordinary Squid calls. It
rejects cycles, unused work, duplicate outputs and arbitrary source strings. The
generated function must still be checked by Squid. Its node/result `let` bindings
reject effects even if the caller could handle them.

The result contains source, dependencies and eligible waves. Eligibility does
not enable parallel execution. The emitted implementation is serial. Gdev's
actor presentation uses this generator and compares every draw field against its
direct reference across 24 scene variants.

`schedule.execute plan initial run commit` is a serial reference for a worker
executor. It checks plan coverage and ordering before running any work, computes
each wave's deltas from one immutable snapshot, then commits them in source
order. Read/write declarations remain the application's responsibility; unknown
or ordered nodes are barriers. A declaration never authorizes concurrent writes
to an ECS world.

`navigation/lookahead.forecast` predicts at most 128 movement steps through at
most eight waypoints using the real continuous locomotion solver. It returns the
path and arrival/block/budget result without changing the source snapshot.
`choose` selects at most eight forecasts deterministically, preserving input
order on exact ties. Applications must attach and revalidate their geometry and
actor revisions before applying a delayed result.

## Saved task lifetimes

`tests/task_world.sq` demonstrates `task_queue` inside an actual word-saved
application. Pending requests are reissued under a fresh epoch after restore;
ready results and explicit continuation data survive. Delivery publishes a ready
prefix in submission order, and old-epoch replies are rejected. The decoder also
rejects future submission/completion times and non-cancelled jobs in closed
lifetimes. Replay owns completion ticks as recorded input.

Speculative previews copy the relevant pools explicitly into separate owners
rather than forking a world implicitly. The task-world fixture verifies that
speculative completion on a copied state cannot consume a real task, change
saved bytes or block a later real completion. No Wasm stack is serialized.
