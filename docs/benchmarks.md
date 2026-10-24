# Blot measurements

Run `deno task bench:library`, or select modules/workload names with
`deno task bench:library physics terrain`. The JSON report is
`.cache/bench-library.json`. `deno task bench` also measures compiler iteration.

The suite covers all 89 modules with 131 representative and adversarial
workloads: 80 core modules and nine optional `pen/*` adapters. Adapter workloads
use independent frozen bindings in `tests/fixtures/pen/`, without a sibling
checkout. This is workload coverage, not exhaustive function/branch coverage.
The report inventories source functions and SHA-256 hashes so measurements can
be tied to their inputs.

Each workload gets a fresh Wasm instance in a terminable worker. Calls include
fixture construction and result decoding, excluding compilation, worker startup
and witness checks. Sizes warm together and rotate through nine measured rounds
after 20 warmups. The expensive terrain-resolution case uses three warmups and
five samples. Every case checks finite/expected outputs, exact deterministic
replay and a stable memory high-water after 16 repeated calls (four for terrain
resolution). A workload has a 30-second total deadline; completed calls
exceeding 256 MiB committed memory fail. Those are harness limits, not universal
application budgets.

Committed Wasm memory includes temporary arena capacity, which resets between
calls but remains committed for reuse. It is neither live object size nor host
RSS. Independent reference/property tests exercise numerical extremes, stable
ordering, exact U32 values, snapshots, search budgets and 600 host-carried
simulation ticks. Memory regressions use isolated fresh guests.

## Further performance candidates (research only)

Five source-overlay prototypes against Ink `1636204` on the same pinned Blot
`b5b12fe` show additional opportunities. They do not modify `lib/`. Reproduce
with `deno run -A tools/experiments/performance-probes.ts`; optional arguments
select probe names such as `handles-encode`, `ecs-history`, `sparse-save`,
`render-collect` or `fused-render`. Run `deno task setup` first. The script
writes its overlays and report under `.cache/next-wins/`. The archived run is
[2026-10-23-next-performance.json](../tools/audits/2026-10-23-next-performance.json).

Each comparison uses 20 warmup pairs and 15 measured pairs, alternating
execution order. Compilation is excluded; fixture construction and guest result
decoding are included. Full returned outputs are compared outside the timed
region. The report records source hashes, compiler provenance, all 39
size/workload comparisons and 24 additional semantic comparisons with the
baseline.

| Candidate                                              | Workload                                                                 | Baseline ms | Prototype ms | Paired reduction |
| ------------------------------------------------------ | ------------------------------------------------------------------------ | ----------: | -----------: | ---------------: |
| Single-allocation handle encoding                      | 8,192 handles, variable-length values                                    |      38.428 |        1.152 |              97% |
| Write sparse saves directly from ECS views             | 65,536 historical slots, 64 initially live, current + previous component |      10.336 |        1.997 |              81% |
| Fuse pose interpolation and matrix construction        | 4,096 moving draws × 16 frames                                           |      67.359 |       44.245 |              35% |
| Skip empty leaves in paired ECS updates                | 65,536 historical slots, 64 initially live; 32 queries + one update      |       7.620 |        4.180 |              45% |
| Memoize unchanged draw collection with `derived/keyed` | 4,096 unchanged draws × 16 frames                                        |      14.972 |        7.210 |              52% |

Recommended implementation order follows this table. Handle saving repeatedly
concatenates growing buffers today; encoding each value once, sizing the final
buffer and filling it preserves the serialized words. The roundtrip fixture
falls from 80.094 to 5.451 ms at 8,192 handles without changing the decoder.
Committed guest memory for the encode workload falls from 4.5 to 2.375 MiB.

Sparse word saving currently materializes every optional component slot and maps
all of them to payload arrays. The prototype visits occupied leaves, encodes
only present values, and preserves the save format, previous snapshots and
ordering. Its sparse roundtrip falls from 20.826 to 4.212 ms; the dense
1,024-entity control also improves by about 9%. Alive flags still occupy one
word per historical entity, so the entire save is not proportional to live
components. A reusable indexed view traversal would keep persistence independent
of ECS leaf internals when implementing this.

The fused rendering path removes intermediate pose/vector construction while
retaining every quaternion normalization and the arithmetic order. A separate
probe compares all 16 matrix words over 4,096 inputs, including zero, huge and
tiny quaternions, negative and zero scales, and extrapolation. That small
standalone loop shows no speedup: the measured benefit is inside the larger
render-cache kernel, where compiler inlining context matters. Keep the general
pose and matrix APIs and use a bounded helper for the combined operation.

The paired ECS update prototype reuses empty leaves and derives membership from
the existing component/alive masks instead of scanning every newly built value.
It retains 32-slot leaves, so later insertion remains valid. Dense/sparse/churn
controls change by approximately 0–2% in paired ratios. Committed memory in the
65,536-slot case falls from 2.5 to 1.75 MiB. Single and triple updates are
further candidates, not measured improvements in this prototype.

Collection reuse needs no new core abstraction: `derived/keyed` already stores
the collected draw array. Callers must invalidate it for changes in draw data,
interpolation, camera, visibility policy and any other predicate dependency.
This is appropriate for static layers or otherwise unchanged views. The generic
memoization wrapper costs about 8% in the 1%-dirty control and 16% when every
draw changes in this run; it should stay opt-in. No GPU or host work is
included.

## Gdev pile-count follow-up

Gdev's current `salt.max_stacks` is 2,000; its largest tracked pile workload
still contains 400. Compact pile rendering and terrain-height caching are
already enabled. A frozen copy of the current game, Ink sources, standard
library and installed compiler isolates this investigation from concurrent
edits. Source/compiler hashes, traces and all repetitions are archived in
[2026-10-23-gdev-bricks.json](../tools/audits/2026-10-23-gdev-bricks.json).

The existing colony save is transformed through the game's typed pile fixture
generator, retaining its workers. Five independent V8 replays per variant use 60
warmup and 180 measured frames at 1280×720, with execution order rotated. Every
complete frame stream and final simulation save matches the baseline. These are
guest CPU measurements, excluding native/browser hosting and GPU work.

| Prototype                                                | 400 piles, paired change | 2,000 piles, paired change |
| -------------------------------------------------------- | -----------------------: | -------------------------: |
| Return unchanged settled stacks; map their update arrays |              2.6% faster |                8.4% faster |
| Reuse unchanged pile pictures and their draw-chunk array |              3.0% faster |                6.7% faster |
| Flat structural pile records (rejected)                  |              3.3% slower |               21.5% slower |
| First two together, separate confirmation                |              5.5% faster |               15.7% faster |

In the combined confirmation, the 2,000-pile median falls from 4.834 to 4.050
ms, p95 from 6.598 to 6.022 ms, and committed guest memory from 4.438 to 4.250
MiB. At 400 piles the median falls from 2.888 to 2.719 ms and p95 is essentially
unchanged. Eight existing picture/flight tests pass on both the baseline and
prototype, including cache invalidation, pile reordering, animation, landing
effects and changed landing targets. The reviewable prototype is
[gdev-settled-piles.patch](../tools/experiments/gdev-settled-piles.patch); it
has not been applied to gdev.

Further targets are local terrain-cache invalidation and rendering detail. The
terrain epoch currently changes every sixth fixed tick, invalidating all pile
heights. In the 2,000-pile diagnostic, salt drawing has a 0.544 ms median and a
1.642 ms p95. Per-region changes or prepared sampling coefficients could reduce
these spikes; neither has been measured here. Pile picking also scans the whole
array in both hand preview and hover, costing roughly 0.29 ms/frame together in
this trace.

The full compact pile mesh contains 528 triangles: 2,000 instances contain
1,056,000 triangles before culling and shadow passes. Correctly authored distant
detail levels are a separate GPU candidate; ordinary mesh simplification cannot
be assumed safe for the shader's encoded brick slots. This environment exposes
no GPU device, so no renderer or displayed-frame-rate improvement is claimed.

## Composition and sparse storage follow-up

The follow-up uses Blot `b5b12fe`, whose qualification passed 2,536 native tests
with exhaustive allocation failures, 1,646 guest tests, 54 harness tests and Zig
lint. Ink passes 412 tests and all 130 benchmark workloads. The generator now
emits exact codec buffers and scalar operations directly; Ink no longer rewrites
generated source strings. App scheduling also accepts the native word save
backend through the same plugin registration path.

`deno run -A tools/followup-bench.ts /path/to/previous/ink` compares the same
fixtures with the old and current library on one compiler. The baseline is
`4098a58`; calls alternate through 20 warmup pairs and nine measured pairs.
Results and validation counts are archived in
`tools/audits/2026-10-23-composition.json`. Prepared physics uses the full-scene
reference in `tools/audits/2026-10-23-composition-levers.json`.

| Workload                                                                          | Reference ms | Current ms |
| --------------------------------------------------------------------------------- | -----------: | ---------: |
| 65,536 historical ECS slots, 64 live; 32 queries and one paired update            |       18.285 |      6.760 |
| Cached draws, 4096 objects × 16 frames, 1% dirty                                  |       15.874 |     14.601 |
| Cached draws, 4096 objects × 16 frames, all dirty                                 |       55.761 |     57.481 |
| Prepared physics, 8192 static colliders, eight bodies and a walker, 16 steps      |      107.359 |     23.728 |
| Prepared physics, 8192 static colliders, eight bodies and a fixed joint, 16 steps |      106.163 |     22.203 |
| Pen decode and CPU assembly, 4096 instances × 16 frames, 1% dirty                 |        2.904 |      1.745 |

These include fixture setup. The sparse ECS workload retains identical witnesses
while committed guest memory falls from 6.375 MiB to 2.5 MiB. Dense and sparse
ECS workloads also improve; churn is roughly unchanged. Render storage shares
untouched pages for sparse edits and uses flat storage for dense changes. The
fully changing case costs about 3% more than the earlier cache; static frames
are roughly unchanged. Background load varied, so small timing differences
remain provisional. The archived paired ratios and sample spreads are more
useful than comparing separate runs.

Prepared walkers query independent moving/static indexes and include their
predicted contact neighborhood; joint anchors are remapped into the compact
solver. Neither needs the old full-world fallback. Pen carries accepted changes
through CPU assembly and GPU upload planning while preserving rejected-update
and skipped-frame semantics. Its CPU comparison uses 20 measured pairs and
excludes GPU frame time. The isolated Pen patch has passing targeted retained
and headless GPU tests, with three broader failures in unchanged tests and
existing Clippy findings documented in
`tools/experiments/pen-retained-instances.md`.

## First architectural experiments

Measured 2026-10-23 with the same pinned Blot `93bc8d4`, Deno/V8 and CPU as
below. `deno run -A tools/levers-bench.ts` alternates paired calls for 20 warmup
pairs and nine measured pairs. These comparisons are included in
`deno task
bench`; results live in `.cache/bench-levers.json` and the checked-in
`tools/audits/2026-10-23-levers.json`. Setup and output decoding are included.

| Path                            | Workload                                         | Existing ms | New ms |
| ------------------------------- | ------------------------------------------------ | ----------: | -----: |
| Unit-cost BFS                   | 512 × 512 flow field                             |      24.168 |  5.390 |
| Cached draw matrices, static    | 4096 objects × 16 frames                         |      68.432 | 11.816 |
| Cached draw matrices, 1% dirty  | 4096 objects × 16 frames                         |      70.005 | 14.735 |
| Cached draw matrices, all dirty | 4096 objects × 16 frames                         |      72.419 | 54.915 |
| U32 codec boundary              | 1024 record round trips                          |       1.271 |  0.279 |
| Native whole-state saves        | 1024 entities; save, restore and snapshot checks |       7.961 |  2.944 |
| Prepared static physics         | 8192 static / 8 dynamic, 16 steps                |      94.454 | 19.993 |
| Generated behavior branches     | 1024 actors, 24 transitions + full traces        |       8.038 |  3.186 |
| Retained Pen packets            | 4096 instances × 16 frames, 1% dirty             |      18.756 |  5.156 |

The codec comparison uses the specialized generated codec on both sides; it
isolates the native U32 boundary from the F32 halves/padding adapter. Strict
primitive specialization is separately checked against the original upstream
encoder/decoder, including malformed words. Native saves additionally exercise
resource/component snapshots, sparse columns, scenes and migrations. The
whole-state comparison performs the same saves, restore and old-world checks
through both formats. Sparse columns encode values once, then fill an exactly
sized buffer; this avoids the initial prototype’s growing-list overhead.

Physics includes one cold static build. It matches the existing solver's
positions, rotations, velocities, sleeping state and full-U32 contact records.
In this first version, walkers and joints used a full-world fallback. Rendering
compared the same ECS views and interpolation frames with flat cache storage.
These workloads differ from earlier small prototypes, so compare within each
row.

The Pen row measures guest encoding. The separately tested Rust decoder plus
retained view assembly took 2.084 ms versus 1.462 ms for all 16 frames: the
first host implementation added bookkeeping cost. Packet traffic fell from
6,301,056 to 497,984 bytes (92.1% less), including the initial reset. The
existing GPU upload planner skips unchanged ranges; no GPU frame-time
improvement is claimed here. Pen retains its normal full draw list for
downstream rendering. Subsequent changes cache its ordering and propagate
accepted dirty slots to GPU upload planning. The updated isolated runtime patch
and its integration notes are in `tools/experiments/pen-retained-instances.*`.

## Earlier performance audit

Measured 2026-10-23 on Ryzen 7 7800X3D, Deno 2.9.7 / V8 15.0.245.2-rusty, Blot
`93bc8d4`. Paired guests compiled the same fixtures with sources from `9fc0869`
and the optimized sources, alternating execution order for 20 warmup pairs and
25 measured pairs. Every pair returned identical witnesses. Times include
fixture setup and output decoding, and renderer timings include final chunk
flattening.

| Workload                                            | Input          | Before ms | After ms |
| --------------------------------------------------- | -------------- | --------: | -------: |
| Behavior stepping                                   | 1,024 actors   |     6.723 |    3.778 |
| Generated codec round trips, including lane adapter | 1,024 records  |     3.252 |    1.691 |
| Sparse/culled render columns                        | 4,096 columns  |     4.379 |    3.902 |
| Default ECS renderer                                | 4,096 entities |     5.430 |    4.801 |

Behavior carries changing fields in locals and constructs its resulting state
once. Codecs allocate one framed record buffer and use a cursor to avoid copying
each remaining tail; native tests compare words and malformed-input decisions
with the unmodified upstream generator. Draw collection selects visible indices
once and fills one output array. The default renderer reads ECS views and emits
a chunk, retaining snapshots and draw order.

The default-renderer improvement includes the collection change. Isolating the
view/chunk change after optimizing columns measured 4.985 → 4.828 ms, about 3%
at 4,096 entities, and reduced committed memory from 3.500 to 3.3125 MiB.
Behavior and codec guests both remained at 128 KiB committed. These fixture
timings are not application frame budgets; memory is arena capacity, not live
object size. `render_meshes` is included in the regular suite with independent
draw-count, position and mesh-id witnesses.

The full 106-workload run passed in 21.59 seconds with deterministic replay and
stable memory high-waters. All 207 measurable scaling comparisons stayed within
their declared complexity; another 20 were too short for a reliable diagnosis.
The 396 tests (30 steps), formatting, lint and type checks also passed.

## October 11 performance audit

Measured 2026-10-11 at 22:44 UTC on an AMD Ryzen 7 3800X (16 logical CPUs, 32 GB
RAM), Deno 2.9.7 / V8 15.0.245.2-rusty, using the pinned Blot compiler
`86a527b97c32331993c4a006da2c982a7336c365`. All 83 workloads passed across all
67 modules in 28.40 seconds. All 100 inventoried source hashes matched after the
run, including transitive standard-library and fixture imports. The report also
records the native compiler and every compiled Wasm SHA-256.

Deterministic replay and committed-memory plateaus passed. There were 176
scaling comparisons within the declared workload complexity, five too short to
diagnose reliably, and no unexpected scaling flags. Seventeen fixtures compiled
in 27–322 ms each. Machine load was 1.83 before and 2.42 after; no project tests
ran concurrently.

Separate paired runs compiled the same fixture against frozen sources before and
after each fix. Their timings below include setup and decoding; they should not
be compared with different fixtures in the full-suite report.

| Paired workload                   | Input                     | Before ms | After ms | Before → after committed MiB |
| --------------------------------- | ------------------------- | --------: | -------: | ---------------------------: |
| Deep modal UI settlement          | 2,048 nodes               |   345.510 |    0.777 |                7.375 → 2.500 |
| Unicode text join                 | 4,096 parts               |   134.057 |    0.073 |              341.813 → 0.375 |
| Unicode word splitting            | 4,096 words               |     3.751 |    0.208 |               43.375 → 0.625 |
| Unicode line splitting            | 4,096 lines               |     4.924 |    0.223 |               43.375 → 0.625 |
| Unique convex hull                | 48 planes                 |    34.915 |   13.046 |             127.938 → 27.438 |
| Redundant convex hull             | 48 planes                 |     8.184 |    0.162 |               31.625 → 0.500 |
| Late animation key lookup         | 8,192 keys, 1,024 queries |    38.973 |    0.479 |                2.375 → 2.375 |
| Input restore                     | 512 held keys             |     0.269 |    0.034 |                    unchanged |
| Dense flock queries, budget eight | 2,048 members             |    19.651 |    1.364 |                    unchanged |
| Dense flock next-velocity array   | 2,048 members             |    15.221 |    1.233 |                1.250 → 1.250 |

UI settlement resolves parent indices once, preserving first-declaration and
full-U32 semantics. Text fills one buffer or collects parts once. Convex hulls
deduplicate clipping planes internally and keep guarded writes reusable;
original planes and complete topology remain identical. Animation uses an
upper-bound key search. Input validates uniqueness through sorted indices and
rejects impossible layouts before mapping them. Flock queries stop reading rows
and candidates when their budget fills; next-snapshot arrays still reuse memory.

The full suite now measures sparse render columns and every Pen adapter. At its
largest sizes, UI parent encoding took 1.018 ms for 2,048 nodes and frame
packing took 1.419 ms for 4,096 draws. Independent witnesses check parent
indices, packet lengths, event values, settings output and deterministic replay.

Five core shaders also passed 117 pixel witnesses across six real GPU pipelines.
A native Vulkan capture exercised the settings UI after the parent-index change.
These validate rendering results; they are not GPU throughput measurements.

Detailed terrain closest-point queries remain an expensive hill: the paired
five-octave fixture took about 79 ms and 196 MiB committed memory. Its cost
grows with footprint and collision resolution. Dense physics and whole-grid
searches retain their real pair/grid work, described below. Passing these
workloads does not establish an optimal implementation or an arbitrary
application's frame budget.

A newer local compiler fixed the pinned compiler's array-copy cliff, but a
standalone primitive-array update control was substantially slower with that
build. The measured reproduction and artifact provenance are in
[blot2 #9](https://github.com/mewhhaha/blot2/issues/9). The library's compiler
pin was retained; these measurements do not claim a released compiler
regression.

## Historical migration measurements

Measured 2026-10-11 at 20:33 UTC on an AMD Ryzen 7 3800X (16 logical CPUs, 32 GB
RAM), Deno 2.9.7 / V8 15.0.245.2-rusty, Blot compiler
`86a527b97c32331993c4a006da2c982a7336c365`. All 66 workloads passed across all
61 core modules in 30.23 seconds. All 83 inventoried source hashes matched the
current files after the run. Deterministic replay and memory plateaus passed;
there were no unexpected superlinear scaling flags. Four very short timing pairs
were below the threshold for a reliable scaling diagnosis.

The one-minute machine load was 3.93 before and 3.75 after the run. No project
tests ran concurrently. These are local fixture measurements, not application
frame budgets; background activity and a different CPU/compiler can change
timings. The JSON retains every size, sample spread, witness and source hash.

| Workload                        | Largest input         | Median ms | Peak committed MiB |
| ------------------------------- | --------------------- | --------- | ------------------ |
| ECS dense updates               | 1,024 entities        | 0.213     | 0.875              |
| ECS sparse updates              | 1,024 entities        | 0.176     | 0.688              |
| ECS removal/reuse               | 1,024 entities        | 0.365     | 4.938              |
| Application scheduling          | 1,024 ticks           | 0.688     | 1.313              |
| Clock scheduling                | 1,024 ticks           | 0.144     | 0.500              |
| Persistence round trips         | 1,024 entities        | 0.430     | 1.125              |
| UI controls and caller glyphs   | 1,024 control batches | 0.305     | 0.813              |
| Normalized input                | 1,024 event batches   | 0.643     | 2.438              |
| UI focus and menus              | 256 route batches     | 0.658     | 4.125              |
| Preferences and tunables        | 1,024 changes         | 0.619     | 1.375              |
| Unicode/numeric text boundaries | 1,024 batches         | 2.083     | 4.125              |
| Brush reconstruction            | 64 brushes            | 2.839     | 8.063              |
| Gizmos, sky and shadow          | 256 batches           | 3.107     | 9.938              |
| Editor picking/view projection  | 1,024 batches         | 4.553     | 11.563             |

Calls include fixture setup and result decoding. Peak committed memory includes
reusable Wasm arena capacity across all tested sizes, rather than live objects.

The gdev migration also passed 503 checks across 56 Blot modules. Its native
Wasmtime frame benchmark measured 0.40 ms median / 0.46 ms p95, compared with
0.38 ms / 0.40 ms before extraction: 300 frames after 120 warmups, using the
same installed host for both runs. Compilation stayed near 2.6 seconds. These
measure game frame production, excluding GPU rendering. Real GPU captures
exercised edit, play, pause and settings, and the five core shaders passed 117
pixel witnesses across six pipelines.

## Allocation bugs fixed

These compare the same isolated workloads before and after the fixes. Timings
are omitted because background machine load changed during the audit.

| Workload                                            | Before committed MiB | After committed MiB |
| --------------------------------------------------- | -------------------- | ------------------- |
| Animation: 512 events × 32 cycles, 16,384 crossings | 1,072.69             | 0.25                |
| Physics: 64 overlapping dynamics, 2,016 pairs       | 94.125               | 27.875              |
| Spatial: 512 dirty dense leaves + snapshot queries  | 437.5625             | 1.125               |
| Scene: 512 dirty dense spheres + snapshot queries   | 443.625              | 7.1875              |

Animation counts crossings and fills one array. Physics collects pairs without
ownership-breaking exits and uses size-weighted sleeping islands. Spatial refits
retain their copied bounds; queries expand intersecting level frontiers. Output
ordering and prior snapshots remain unchanged. The numerical tests also found
and fixed normalization errors for tiny/huge rotation inputs.

## Historical baseline: 30 modules / 45 workloads

Measured 2026-10-11 at 16:18 UTC on an AMD Ryzen 7 3800X (16 logical CPUs, 32 GB
RAM), Deno 2.9.7 / V8 15.0.245.2-rusty, Blot compiler
`86a527b97c32331993c4a006da2c982a7336c365`. All 45 workloads passed; no
unexpected superlinear scaling flag remained in the ordinary linear/sort cases.
**Timings are provisional:** background load exceeded the machine's CPU count.
The report retains load before/after and median/min/max/MAD for every size.
Measure on an idle target machine before setting frame budgets.

These are complete fixture calls, often exercising several helpers per item. The
JSON contains all sizes; this table shows the largest ordinary batch.

| Module      | Largest input                   | Median ms | Peak committed MiB |
| ----------- | ------------------------------- | --------- | ------------------ |
| math        | 4,096 items                     | 13.460    | 16.000             |
| arrays      | 4,096 items                     | 0.077     | 0.250              |
| random      | 4,096 states                    | 0.022     | 0.125              |
| noise       | 4,096 mixed noise samples       | 55.454    | 49.750             |
| time        | 4,096 timer/fixed-step updates  | 0.668     | 1.125              |
| transform   | 4,096 items                     | 55.928    | 55.375             |
| color       | 4,096 items                     | 4.032     | 2.000              |
| lighting    | 4,096 items                     | 28.985    | 22.375             |
| environment | 1,536 samples                   | 0.869     | 1.312              |
| shadow      | 256 fits                        | 2.599     | 3.250              |
| motion      | 4,096 items                     | 11.550    | 12.188             |
| steering    | 1,024 items                     | 9.952     | 6.250              |
| audio       | 4,096 items                     | 10.237    | 11.500             |
| terrain     | 1,024 combined queries          | 105.201   | 73.188             |
| tiles       | 4,096 moves/queries             | 7.555     | 5.000              |
| spatial     | 4,096 leaves, one dirty         | 5.344     | 4.062              |
| scene       | 4,096 spheres, one dirty        | 10.533    | 12.125             |
| shapes      | 512 combined shape queries      | 18.536    | 25.062             |
| contact     | 256 groups of three shape pairs | 6.687     | 18.562             |
| rigid       | 256 body/contact groups         | 5.765     | 22.062             |
| character   | 256 controller moves            | 6.840     | 14.438             |
| placement   | 64 × 16 cells                   | 2.734     | 4.875              |
| debug       | 4,096 lines                     | 0.694     | 0.875              |
| camera      | 16,384 bounds                   | 5.385     | 15.625             |
| particles   | 4,096 particles                 | 1.858     | 3.000              |
| animation   | 512 bones                       | 0.991     | 2.875              |
| sort        | 8,192 full-width keys with ties | 1.929     | 1.500              |
| physics     | 256 sparse bodies               | 6.142     | 22.375             |
| joints      | 1,024 constraints               | 3.796     | 4.562              |
| navigation  | 512 × 512 open-grid A*          | 6.843     | 14.125             |

## Historical adversarial costs

| Adversarial workload                | Largest input           | Median ms | Peak committed MiB |
| ----------------------------------- | ----------------------- | --------- | ------------------ |
| Fully dirty spatial refit + queries | 1,024 dense leaves      | 1.148     | 1.062              |
| Fully dirty scene update + overlaps | 1,024 dense spheres     | 4.401     | 14.812             |
| Particle triangle vertices          | 1,024 particles         | 0.919     | 1.125              |
| Expired/mixed particle filtering    | 4,096 particles         | 0.685     | 2.188              |
| Animation event crossings           | 512 events × 32 cycles  | 0.543     | 0.250              |
| Dense overlapping physics           | 64 bodies / 2,016 pairs | 66.027    | 27.875             |
| Complete flow field                 | 512 × 512 cells         | 114.175   | 14.125             |
| Unreachable A*                      | 256 × 256 cells         | 22.260    | 3.625              |
| Budgeted A* (16 expansions)         | 256 × 256 cells         | 0.430     | 3.625              |
| Placement spacing/cell ratio        | 8                       | 3.331     | 6.750              |
| Whole terrain bounds                | 128 × 128 cells         | 0.102     | 0.250              |
| Flat-terrain closest segment        | 64 metres               | 0.903     | 1.562              |
| Redundant convex planes             | 48 planes               | 11.887    | 31.562             |
| Unique convex planes                | 48 planes / 92 vertices | 49.372    | 115.375            |
| Detailed-terrain closest segment    | 5 noise octaves         | 89.114    | 196.125            |

- Convex construction drops duplicate planes, intersects every triple of the
  distinct ones and tests each candidate vertex against the plane that last
  rejected one before the rest: about cubic work. Build/cache authored hulls
  when geometry changes; avoid rebuilding many-plane hulls each frame.
- Terrain closest-point searches scale with footprint area and the inverse
  square of the finest collision step. Five octaves in this 4-metre segment
  fixture mean a 0.125-metre step and roughly 2,345 candidate sites before
  pruning. Keep collision detail coarser than visual detail and query at a
  bounded cadence. Refinement is numerical, not a global-distance guarantee.
- Dense physics must emit quadratic contact pairs. Keep active overlap density
  bounded; faster pair collection cannot remove the solver's real pair work.
- Whole-grid flow fields and unreachable searches visit large portions of the
  grid. Cache fields until costs/goals change and choose explicit A* budgets.
- Placement neighbour work grows with spacing/cell ratio. Choose a cell scale
  near the intended spacing.

Passing these fixtures establishes bounded, correct behaviour for their tested
inputs. It does not make arbitrary caller sizes or non-finite unchecked inputs
safe, or certify a frame budget for a different CPU/compiler/browser.

## Applied gdev pile improvements, 2026-10-23

All five follow-ups are implemented in the sibling game: unchanged settled
stacks and draw chunks are reused; surface revisions cover local tiles and every
sample touched by the height spline; picking shares exact ray results while
checking geometry and terrain; and authored distant meshes preserve each brick's
independent slot and rotation. Footsteps mark their bounded dirty tiles
directly. Arbitrary terrain replacement still compares samples, and deposited
dust does not invalidate today's height. These are game-specific policies; no
new Ink mechanism was needed.

Five alternating replay pairs per workload used the same frozen compiler, Ink,
game sources and saves, with 60 warmup and 180 measured frames at 1280×720 and a
fixed 1/60-second step. The table gives medians across independent replays:

| Piles | Guest median before → after | Guest p95 before → after | Peak committed Wasm memory |
| ----- | --------------------------- | ------------------------ | -------------------------- |
| 400   | 2.847 → 2.715 ms            | 3.789 → 3.763 ms         | 1.750 → 1.750 MiB          |
| 2,000 | 4.614 → 3.792 ms            | 6.368 → 5.885 ms         | 4.438 → 4.250 MiB          |

The median paired reductions were 3.0% and 17.8%. The 400-pile tail was roughly
unchanged (paired p95 varied by about 1%); the 2,000-pile paired p95 improved
7.4%. Every frame-stream and final-save hash matched across all 4,800 replayed
frames. These are diagnostic CPU timings, excluding GPU work.

Distant bricks use 12 triangles instead of 44, a 72.7% reduction for selected
coarse levels. Geometry checks verify slot ownership, winding, palette, the
convex-source error bound and rotated culling bounds. Native Vulkan software
renders were inspected at overview and close distances; the close foreground was
pixel-identical to the original meshes. This verifies rendering, not hardware
GPU speed. The game benchmark suite now includes a reproducible
2,000-pile/80,000-logical-brick fixture retaining the colony residents.

The merged current-source tree passed `pen check`, `pen codegen --check`, 33
focused Blot tests and two geometry tests. The broader game run passed 1,027
tests; all 19 failures and the remaining `ReadView.masks` compile error were
reproduced against the unchanged sources. Ink lint and type checks passed;
formatting, three inventory tests and the library benchmark inventory check
remain affected by separate concurrent module additions. The new
cache-inspection plugin in the game was preserved.

Raw paired results, hashes, validation details and applied-file checksums are in
[the implementation audit](../tools/audits/2026-10-23-gdev-pile-implementation.json).
The [source patch](../tools/experiments/gdev-pile-performance.patch) contains
the code, tests, generator and suite edits; generated meshes and the binary
fixture were applied directly to gdev.

## gdev guest CPU follow-up, 2026-10-24

The [measured candidate](../tools/experiments/gdev-cpu-followup.patch) remains
experimental and has not been applied to the live game. It bounds footprint
stamping to affected columns, reuses unchanged pile pictures earlier, and defers
hand-effect parameter preparation until the material needs it. The patch also
adds an explicit `just dev-fast` command (`BLOT_INLINING=1 pen dev`); the
ordinary development command retains its faster compilation setting.

The maximum-pile fixture normalizes to 45 gnorps, 18 buildings and 2,000 piles;
the hand workload carries another 40 bricks. Four alternating native pairs, 600
frames each with 120 warmup frames and periodic snapshots, measured the
following medians across runs with native inlining disabled:

| Metric               | Before   | Candidate |
| -------------------- | -------- | --------- |
| Median guest request | 4.726 ms | 4.649 ms  |
| p95 guest request    | 7.123 ms | 6.629 ms  |

This is a 1.6% median reduction and a 6.9% p95 reduction in that configuration,
not a general frame-time guarantee. One candidate run reached 10.369 ms p95.
These are elapsed request times, so CPU contention contributes. Native results
with inlining enabled were mixed: unrestricted runs were modestly better, but
the two-core-affinity runs regressed. Some optimized runs overlapped background
compilation. That uncertainty is why the patch is preserved for review rather
than treated as a production optimization.

An indexed hand-draw mutation, smaller terrain invalidation tiles and SIMD
packet stores were also tested and excluded. The indexed hand mutation was
faster in V8 but substantially slower in native execution. Qualify guest changes
on both runtimes before accepting them. Pen's development runtime disables
native inlining by default; enabling it is an explicit compilation/runtime
tradeoff, with no game simulation or wire-format change.

All four replay scenarios retained identical complete frame-stream and final
save hashes (1,920 V8 frames). A separate native comparison matched every byte
of 60 frames, about 16.8 MB per variant. The merged candidate passes 58 focused
game tests, `pen check` and `pen codegen --check`. Full Ink validation is
recorded in the [audit](../tools/audits/2026-10-24-gdev-cpu.json), including all
paired runs, source/binary identities, rejected experiments and measurement
limitations.

## Six performance experiments, 2026-10-24

The accepted Ink changes remove a repeated restitution-array copy, initialize
spatial bounds in one pass, add exact indexed point queries, and provide
optional retained-render and native worker adapters. The
[gdev patch](../tools/experiments/2026-10-24-gdev-performance.patch) integrates
indexed pile searches and retained pile rendering. The
[Pen patch](../tools/experiments/2026-10-24-pen-performance.patch) supplies the
matching protocol, transactional instance cache, sparse GPU uploads and native
worker callback. These sibling changes are staged patches, following the choice
to keep this work in Ink. The game patch targets `5b44982`; it needs rebasing
over the concurrent pile-ID and saved-target changes in the live checkout. The
Pen patch targets `313b60e`. Both apply cleanly to their recorded bases and
reproduce the tested files.

The installed compiler changed during the investigation. Final qualification
uses a frozen compiler with SHA-256
`321d17443706884fdf5b80d7e181aa8975a39eee778a3f9f3f50a81aa533439a`. Three
alternating native pairs replayed 600 frames each, discarding the first 120. The
saved workload contains 45 gnorps, 18 buildings and 2,000 piles. Guest thread
CPU time excludes descheduling, compilation and host rendering, but CPU
frequency and cache contention still affect results.

| Measurement                         | Before     | Candidate  |
| ----------------------------------- | ---------- | ---------- |
| Median of run medians, guest CPU    | 3.691 ms   | 3.102 ms   |
| Median of run p95s, guest CPU       | 6.743 ms   | 4.837 ms   |
| Wire bytes over 120 captured frames | 33,393,788 | 10,598,812 |
| Restitution kernel, 2,048 contacts  | 1.183 ms   | 0.394 ms   |

The paired median CPU reductions were 23.0%, 13.5% and 20.9%; all six final
saves have the same SHA-256. These are a fixed workload's results, not a promise
for every live-session spike. Every lane of 120 resolved render frames matched
bit-for-bit after canonical draw ordering and pose-index remapping. The final
1280×720 image, after sequentially rendering frames 0, 60 and 119, was
pixel-identical under software Vulkan. GPU tests also verify that unchanged
retained scenes upload no instance data. No hardware GPU speed claim is made.

Two experiments were deliberately excluded from the default implementation:

- Padded and dense ECS pages preserved correctness but did not provide a
  reliable game benefit. Dense pages were 6–9% slower than original storage in
  the paired ablation. The
  [dense-page patch](../tools/experiments/packed-ecs-pages.patch) remains
  available for research; Ink keeps its original ECS.
- [SIMD acceleration](../tools/experiments/simd-acceleration.patch) depended on
  workload size and compiler context. The final fixture improved at large sizes
  but regressed at small sizes; an earlier qualification also regressed in the
  middle. The scalar path remains the default. Full output bits and retained
  input snapshots are tested for both variants.

The optional worker prototype runs actual pure route forecasts with geometry in
every request. For 32 jobs, four workers reduced the batch median from 1.752 to
1.511 ms; one worker increased it from 1.774 to 2.889 ms. These include packet
encoding, copying, fresh guests, worker startup, ordered joins, decoding and
shutdown. The normal game's actor ticks do not use this callback. It is
currently a native Pen capability; browser hosts do not implement it.

Reproduce the game module with
`deno run -A tools/experiments/build-performance-replay.ts GAME SAVE OUTPUT`,
using `GAME/benchmarks/fixtures/piles2000.bin` and `INK_BLOT_ROOT` to select the
qualified compiler installation. Append `immediate INK_LIB` for an unchanged
game/Ink baseline. The builder reproduces the measured candidate Wasm exactly.
The Pen patch includes `replay_cpu`, `compare_retained` and `compare_batch`
examples. The restitution/SIMD fixture is `tests/perf/rigid-costs.blot`; the
regular library benchmark now covers all 100 modules with 140 workloads,
including the new point index, retained adapter and worker packet codec.

The game run passed 1,088 tests; all seven devtools tests subsequently passed
after fixing a compiler inference issue in the host wrapper. One fixture,
`language_compatibility.blot`, still fails with `InvalidArtifact` on both the
unchanged baseline and the candidate. The actual game and devtools entrypoints
compile. Native worker, protocol, runtime, sparse upload and Vulkan culling/LOD
checks pass.

[The audit](../tools/audits/2026-10-24-performance-six.json) records per-frame
CPU samples, all paired runs, compiler and Wasm identities, complete patch file
hashes, pixel witnesses, rejected experiments and validation details.

## General motion primitives and packed application records, 2026-10-24

`ink/motion` now supplies semi-implicit Euler integration over scalar values,
four independent SIMD lanes, or persistent numeric columns. The inputs, timestep
and storage belong to the caller. No game identities, pile rules, gravity
constants, landing effects or timers enter Ink.

The [gdev integration patch](../tools/experiments/2026-10-24-gdev-motion.patch)
changes its own `Stack` to a flat structural record, calls `motion.integrate`
from its settlement policy, and reuses the array when every stack is settled.
Full-width U32 identities and the existing saved-state codec are preserved. The
patch also updates the two constructor consumers and adds an exact-bit
settlement/snapshot witness. It applies with zero fuzz over the concurrent
ghost-presentation and delivery-accounting edits, but live application awaits
approval after automatic review enforced the earlier patch-only instruction.

The qualified installed compiler has SHA-256
`0185500e446d59d6e813de8cecb3318bcc5983632043eb0129b8a64bad45ee9f`. The
numeric-column test performs 32 steps per call. At 2,048 coordinates, SIMD
reduced native time from 0.217 to 0.130 ms, about 40%, with every output and
original input-snapshot bit unchanged. Short tails use scalar operations. The
test suite also covers signed zero, negative timesteps, length mismatches and an
independent F32 arithmetic oracle.

Packing the application records improved the synthetic 32-step workload by
roughly 40%. A generic callback over four records was slower than scalar
mapping; converting records into columns and back each tick was slower too.
Those experiments remain in `tools/experiments/general-motion-probe.blot` and
`general-motion-batches.blot`. Gdev therefore uses the shared scalar integrator
with packed records; callers already retaining numeric columns can use SIMD
without the conversion cost.

Three alternating pairs of native game replays used the same frozen sources
except for this change: 600 frames, 120 warmup frames, 45 gnorps, 18 buildings
and 2,000 piles. Median guest thread CPU improved by 6.4%, 8.9% and 7.1%. The
median of run medians changed from 3.608 to 3.378 ms. Every complete 600-frame
stream and final save hash matched. This measures the specific workload,
excludes GPU work and descheduling, and still reflects variation in CPU
frequency and cache contention.

The reusable [CPU runner](../tools/experiments/replay-cpu.rs) hashes complete
frames and saves outside its timed guest calls. Copy it into Pen's
`crates/blot-host/examples/` and build it there; it takes a Wasm path and an
output JSON path. Use `tools/experiments/build-performance-replay.ts` with
`immediate` mode for both original and candidate game sources, and explicit Ink
library directories to keep unrelated work fixed. The regular
`motion-columns-original` and `motion-columns-vector` benchmarks cover the
published primitive.

Ink's full run passed 446 tests. The isolated game passed `pen check`,
`pen codegen --check` and 90 relevant tests. A stations-button assertion fails
on both the frozen original and candidate; it is outside this change. The
[audit](../tools/audits/2026-10-24-general-motion.json) contains all paired
results, kernel samples, artifact identities, rejected approaches and final
validation status.

## General mechanisms extracted from application code, 2026-10-24

Six mechanism families now live in Ink: tiled-field invalidation, bounded
histories/statistics, anchored panel layout, rounded outline geometry, console
history/completion, and localized-text request caches. They occupy eight small
modules because statistics and the optional Pen locale adapter have separate
boundaries. Caller-owned values, clocks, dimensions, catalogs and policy remain
explicit. The sensor-dashboard example uses every family without gdev or Pen.

The
[nine-file gdev patch](../tools/experiments/2026-10-24-gdev-mechanisms.patch)
adopts all six on an isolated working copy. Gameplay, assets, shader parameters,
HUD exclusions, source categories and command execution remain in gdev. Its
saved-state formats are unchanged. The patch remains an Ink artifact under the
earlier patch-only instruction; it has not been applied to the live checkout.

The measurable algorithm change is timestamped bounded history: expiration
visits expired entries, and surviving samples keep their timestamps instead of
having their ages rebuilt every tick. A 64-sample microbenchmark returns the
same retained count and value sum for both implementations:

| Updates per call | Native age-array baseline | Native timestamp buffer |
| ---------------- | ------------------------- | ----------------------- |
| 64               | 0.282 ms                  | 0.032 ms                |
| 256              | 2.016 ms                  | 0.128 ms                |
| 1,024            | 9.040 ms                  | 0.573 ms                |

At 1,024 updates that is 93.7% less native time. The V8 workload changed from
5.407 to 0.370 ms. These are kernel measurements, including input/output
copying, not whole-game frame improvements. Native measurements use 11
alternating paired rounds of 50 calls after warmup. The installed compiler
SHA-256 is `0185500e446d59d6e813de8cecb3318bcc5983632043eb0129b8a64bad45ee9f`.

The game rate display retains its quarter-second sampling and ten-second window.
It periodically shifts its timestamp origin to preserve F32 precision during
long sessions. An independent age-based reference matches through 1,600 updates
with expiry, pauses, counter resets and repeated rebasing. Panel/outline
geometry matches the previous code across 1,224 comparisons at 0.001
logical-pixel tolerance. The migration preserves the original F32 above/beside
decision; a mathematically equivalent rearrangement changed that branch near its
boundary.

Ink passes 449 tests, checks and the complete benchmark task: 109/109 modules,
152 workloads, zero benchmark failures. The isolated game and devtools compile,
generated bindings pass checking, and 66 distinct relevant tests pass. One
station-panel height assertion fails identically on the unchanged baseline
(expected 396, got 288); it is unrelated to these extractions.

The [audit](../tools/audits/2026-10-24-general-mechanisms.json) records source
and patch identities, native samples, V8 workloads and validation. Reproduce the
library runs with `deno task bench:library mechanisms`. For native comparison,
run `tools/experiments/build-history-benchmark.ts` with the qualified
`INK_BLOT_ROOT`; then build
[compare-kernels.rs](../tools/experiments/compare-kernels.rs) as a Pen
`blot-host` example and pass the generated Wasm, workload JSON and an output
JSON path. The builder writes to `.cache/history-benchmark/`.
