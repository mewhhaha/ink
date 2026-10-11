# Blot measurements

Run `deno task bench:library`, or select modules/workload names with
`deno task bench:library physics terrain`. The JSON report is
`.cache/bench-library.json`. `deno task bench` also measures compiler iteration.

The suite covers all 61 core modules with 66 representative and adversarial
workloads. Six optional `pen/*` adapters require caller-generated bindings and
have separate integration tests; they are not counted as measured core modules.
This is workload coverage, not exhaustive function/branch coverage. The report
inventories source functions and SHA-256 hashes so measurements can be tied to
their inputs.

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

## Current migration measurements

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

- Convex construction intersects plane triples and tests candidate vertices
  against every plane: up to quartic work. Build/cache authored hulls when
  geometry changes; avoid rebuilding many-plane hulls each frame.
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
