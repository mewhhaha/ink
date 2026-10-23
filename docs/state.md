# Application state mechanisms

These modules keep identities, cached calculations and behavior progress in
caller-owned Blot values. Their fixtures use building, staffing and delivery
vocabulary; the library does not. See `tests/handles.blot`,
`tests/derived.blot`, `tests/codec.blot` and `tests/behavior.blot` for complete
integrations.

## Stable handles

`handles.make kind region origin capacity` creates an empty store. Use a
distinct nominal kind for each object category, for example
`type Building is data =
#Building`. `Handle Building` cannot address
`Store [Pile, value]`. Both handles and stores are opaque; use `get`, `set`,
`insert`, `remove`, `handle_at`, `values` and `count`. Operations that can fail
return `Maybe`. `insert` returns the new store and handle; all operations
preserve older stores.

A handle contains four U32s: region, birth origin, slot and generation. The
caller must allocate unique region ids for independent stores, and fresh origin
ids before allocating in divergent histories. `fork origin store` retains
identities from the shared past but gives new allocations the new origin. Never
reuse an origin within a region while handles from that history can remain
observable, including after a restore. Local checks catch some reuse; they
cannot know about other branches. For unrelated restores, allocate a new region
and explicitly migrate references instead of retaining their old identity.

Lookup is constant-time indirection. Iteration follows dense order; removal
swaps the last value into the hole. The moved value keeps its handle. Free slots
are reused last-in-first-out. A removed slot increments its generation; at U32
maximum it retires permanently. Capacity counts allocated slots, including
retired ones. No operation scans the application's references. Immutable array
updates can still copy store arrays, so churn with retained snapshots can be
quadratic.

`encode_handle` uses four exact U32 words; `decode_handle kind` reconstructs
them without asserting that they resolve. Version-1 `encode encode_value` saves
region, origin, capacity, slots, dense owners, free order and framed values.
`decode kind
decode_value` validates their indirection and framing. A round trip
preserves future allocation order and object identity.
`from_dense kind region origin
values` also returns the old-index-to-handle
migration table; applications choose fallbacks for deleted homes and delivery
targets.

## Checked derivation and persistence

Run the repository tool after `deno task setup`:

```sh
deno run -A tools/derive.ts \
  --source tests/fixtures/derived/model.blot \
  --schema tests/fixtures/derived/schema.json \
  --output tests/fixtures/derived/model_derived.blot \
  --published tests/fixtures/derived/published.json --check
```

Omit `--check` to regenerate. `--manifest-output PATH` writes the next published
layout; review it against the previously shipped manifest before replacing that
baseline. CI should use `--check` and the baseline. The input and generated
output are separate files in the same directory; applications import the
generated module, which includes the checked declarations. These are development
tools, excluded from the source package. Vendoring the repository makes them
available.

Each generated `Name_codec migrate` factory applies its metadata key, version
and capacity; `Name_descriptor` exposes its semantic fields. The caller supplies
the migration function, including `codec.no_migration` when appropriate.

The tool runs the native checker, uses upstream `dataShapes` and `deriveCodec`,
and checks the generated source. A buffer pass on the pinned generator's output
allocates each record's output once and decodes fields with a bounded cursor,
avoiding repeated concatenation and tail slicing. Field codecs, validation and
wire words are unchanged; an unrecognized upstream template rejects generation.
There is no second Blot parser. The compiler, generator and parser artifacts
share the exact compiler pin and verified local cache. Metadata explicitly
assigns section keys, type versions, variant tags and field ids. Source field
reordering preserves encoding; labels are inspection metadata. Duplicate ids,
stale output, changed section keys, decreasing versions, and changed layouts
without a version bump are rejected. Recursive derivation requires a handwritten
codec. For collections of user types, use record fields such as
`#Batch { sites: Array Site }`; parenthesized positional collection types are
outside this qualified generator path. Unsupported source types remain native
checker/generator errors, never a guessed layout.

`ink/codec.Codec` has the upstream `encode`/`decode` contract and framed U32
representation. Ink owns this equivalent contract because Blot's orphan rule
forbids implementing `std/codec.Codec F32` in Ink. The upstream generator is
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

`deno task bench` measures the four modules at 64, 256 and 1,024 objects, with
independent witnesses, replay and guest memory growth checks. Handle workloads
cover lookup, dense iteration and churn while retaining an old snapshot,
including dense-index baselines. Staffing compares 32 cached evaluations against
32 full scans. Codec benchmarks compare the derived adapter with a handwritten
seven-lane baseline; behavior dispatch has an explicit state-machine baseline.
Results live in `.cache/bench-library.json` with compiler, machine and source
fingerprints. These small building/worker/delivery fixtures qualify mechanisms
and costs; they do not claim that a complete gdev application has been migrated.

### Recorded costs

On 2026-10-23, Deno 2.9.7 / V8 15.0.245.2-rusty, Linux x86-64, Ryzen 7 7800X3D
and Blot `93bc8d4`, the paired benchmark measured the following medians for
1,024 items. Times include construction and decoding of fixture results.

| Workload                            | Mechanism (ms) | Baseline (ms) | Paired guest committed memory |
| ----------------------------------- | -------------: | ------------: | ----------------------------: |
| Handle lookup                       |         0.1083 |        0.0040 |                       256 KiB |
| Handle iteration                    |         0.0454 |        0.0020 |                       256 KiB |
| Handle churn with retained snapshot |         0.9680 |       41.8974 |                       448 KiB |
| 32 staffing evaluations             |         0.0221 |        0.0136 |                       128 KiB |
| Codec round trips                   |         1.8088 |        0.0279 |                       128 KiB |
| Behavior dispatch                   |         3.8041 |        0.0117 |                       128 KiB |

Dense lookup is cheaper; handles buy stable identity and avoid the dense
baseline's reference-remapping scans on deletion. Constructing the handle store
is included in the lookup/iteration batch. The staffing sum is so cheap that
stamp validation and cached-result bookkeeping still cost more at these sizes,
despite reducing 32 full scans to one. Use caching for expensive calculations
and measure the actual workload. The handwritten codec's seven lanes sacrifice
full-width U32 identity; the generated adapter preserves it with larger framing
and validation costs. The behavior baseline is a fixed, scalar state machine the
compiler can optimize aggressively; the generic interpreter buys typed
callbacks, inspected steps and saveable progress at a substantial cost. At this
workload 1,024 actor steps cost about 3.8 ms: budget and profile it before
adopting it for crowds. Committed memory is the paired guest's high-water
allocation, not live bytes per object. Full library benchmarks separately verify
stable memory across replay.

## Native word saves

`ink/persist/words` carries `Array U32` directly through the guest's U32 ABI.
Construct `codec.saved key version encode decode migrate`, or use generated
`Name_words migrate`. Register it with `words.new`, `resource`,
`snapshotted_resource`, `component` or `snapshotted_component`, then call
`encode_state` / `decode_state` or `encode_scene` / `decode_scene` inside an ECS
scope. `tests/word-persist.blot` is a complete example. Hosts copy the returned
`Uint32Array` bytes; numeric conversion to `Float32Array` loses integer bits.

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
existing `Name_codec` factory still supplies the F32 host adapter. Pen's current
state-command interface uses that adapter; it already retains guest state
between frames. Native word persistence is an alternative boundary for
applications whose hosts accept U32 buffers, not a change to Pen's state ABI.

## Compiled authored behaviors

`tools/behavior-derive.ts` compiles a caller-authored JSON graph into direct
Blot branches. It checks the callback source and generated output with the
pinned native compiler. Run:

```sh
deno run -A tools/behavior-derive.ts \
  --source tests/fixtures/behavior/actions.blot \
  --graph tests/fixtures/behavior/graph.json \
  --output tests/fixtures/behavior/actions_derived.blot
```

Use `--check` for reproducibility checks. Input/output must be distinct files in
the same directory. The manifest names the graph, version, entry ID, local/
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
