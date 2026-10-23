# Blot measurements

Run `deno task bench:library`, or select modules/workload names with
`deno task bench:library physics terrain`. The JSON report is
`.cache/bench-library.json`. `deno task bench` also measures compiler iteration.

The suite covers all 88 modules with 130 representative and adversarial
workloads: 79 core modules and nine optional `pen/*` adapters. Adapter workloads
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
