# Package boundary

Ink is a Blot source library under `lib/`, imported through a caller's `ink/`
alias. It owns reusable game mechanisms: calculations, simulation, typed ECS,
scheduling, codecs, persistence, input, declarative drawing and sound, headless
UI and editing tools. Core modules depend only on Ink and Blot's standard
library. [API contracts](blot.md) define numerical and packing conventions.

Applications own their values, assets, vocabulary, configuration and
composition. They choose the timestep, catch-up budget, camera lens, input
bindings, font metrics, service retries and initial resources. A builder
registers an explicit world; execution returns a new world and preserves earlier
snapshots. Ink owns no global game state or application loop.

Sparse work stays explicit: `changes.apply` maintains caller-owned active keys,
and selected ECS updates copy touched leaves once while sharing other storage
with earlier worlds. Applications decide which objects wake or sleep.
`field/buckets` indexes authored sample footprints in stable source order;
applications supply field evolution and scheduling policy.

`map` and `set` store generic keys in persistent hash tries. Edits share
unchanged branches with earlier snapshots; no global table, random seed or
application identity is hidden in the collection. Callers supply a consistent
pure hash/equality policy separately from saved data. `hash` provides
deterministic word, text and compound-key helpers. Set operations reuse the map
mechanism, and applications choose serialization and presentation ordering.

`lib/pen/` is an optional Blot adapter. It translates Ink values to generated
`pen/` wire records and back. Pen generates and owns those records and imports
no Ink or game modules. Pen owns compilation, transport, native services,
rendering and audio playback. Other hosts can supply their own adapters without
changing core Ink.

Consumers map a compiler alias to `lib/`. `pen tool ink -- pack DIR` exports
Blot modules, five core WGSL shaders, examples, documentation and a content-hash
inventory. The [shader contracts](shaders.md) define bindings and vertex layouts;
callers own the renderer and GPU resources. Tests compile examples from an
isolated copy under a different import alias, without a package-manager shim.

Tests and tools remain outside the source distribution. `pen test-blot` runs
Blot checks and the Rust reference suite declared in `pen.json`. Both use Pen's
compiler plugin and Wasmtime host. Rust owns independent numerical references,
GPU pixel witnesses, package checks and development generators. No game entry,
window, JavaScript runtime or alternate compiler bootstrap is needed.
`pen tool ink -- bench` measures all library modules, scaling, replay and memory
growth while checking numerical witnesses. See [testing](testing.md).

Application normalizers are a separate `app.Normalize` stage. They establish
cross-resource invariants after starts and before consumers of restored state,
independently of pause/update guards. Decoding creates a pending world; events,
advance and presentation boundaries normalize it before calling user systems.
Custom low-level ECS consumers can call `app.ensure_normalized` explicitly.
Normalization is not a per-frame gameplay repair pass.

`derived/keyed.Cache` stores a value with the complete dependency key that
produced it. Callers own storage, equality and rebuilding. Revision tokens are
bumped by the operation that owns a change; a restore starts transient caches
cold. `navigation/locomotion` applies an explicit ground-motion request and
returns a pose, gait phase and arrival result without knowing an actor's job or
cargo. `handles`, `derived`, `behavior` and `codec` add explicit
application-state mechanisms without owning a world, clock or host. The opt-in
`pen tool ink -- generate` checks both model and output with the native compiler; its generated
application types remain outside the library. See [state contracts](state.md).

Optional `render/cache`, `physics/prepared` and `persist/words` mechanisms keep
explicit caller-owned presentation snapshots, static collision geometry and
word-native saves. They introduce no world loop or platform resources. The
`changes` module describes explicit invalidation; `pages` shares untouched
storage between snapshots. Application scheduling uses a caller-selected save
backend, so the same plugins work with lane or word persistence. Collision
queries compose independent scenes without rebuilding a combined index. The
behavior source generator specializes caller-authored graphs outside the
published package. `render/retained` keeps caller-owned instance identities and
emits explicit updates and removals. The optional Pen adapter carries these to
the host's transactional instance cache; GPU resources remain in Pen. A world
replacement or a frame that disables retained rendering requires a fresh stream
reset.

`render/retained.update_keyed` accepts mutation-generated group changes and
only requests draw values for updated keys. Its paged identity table and old
streams remain valid across forks or rejected frames. The optional host adapter
still owns transport and GPU resources.

`spatial/points` performs exact nearest-point queries in the floor plane, with
source indices breaking ties. Applications keep the index with its positions and
rebuild it on movement or membership changes.

Native Pen's optional `pen/workers` callback submits bounded numeric batches to
isolated guest instances. The module supplies a pure `plan` entry; all results
join in submission order before the call returns. Mutable worlds and structured
task continuations never cross this boundary. Applications decide whether a
batch is large enough to justify copying and worker startup; the browser host
does not offer this native callback.

The separate `pen/worker_session` service retains a prepared immutable context
inside an isolated native guest. A matching host pool supplies explicit context
revisions, ordered jobs, resets and failure recovery. It never transfers a live
world or chooses when a simulation should publish results. Workers remain an
optional host capability.

`field` composes explicit sample regions and tile revisions with
`derived/keyed`. `history` and `statistics` operate on caller-owned samples,
clocks and counters. `ui/anchor`, `ui/outline` and `ui/console` supply layout
geometry and headless interaction mechanisms with caller-provided catalogs and
policy. `locale` caches text independently of its source; optional `pen/locale`
handles Pen requests and response framing. None owns application assets,
vocabulary, simulation rules, resource keys or loops.

`app.hold_frame` lets an event hold simulation for one host frame, for example
for impact hit-stop. It drops that frame's elapsed time while preserving the
clock remainder, and leaves input, rendering and `app.Pause` alone. The request
is a transient output consumed by `advance_scoped`; it never enters a save or
causes catch-up on the following frame.

`reconcile` matches caller-owned collections by unique U32 keys without taking
over allocation, animation or removal policy. `trajectory` separates analytic
paths from contact queries; callers choose collision subdivision and outcomes.
`field/sample` supplies numerical sampling independently of field evolution.
`profile` aggregates caller observations and lays out flame rectangles, while
optional `pen/profile` decodes the host's inspector responses. `render/lod`
calculates projected extents and selects caller-defined detail levels. None of
these mechanisms knows an application's entities, assets or gameplay rules.


Observed resources also support explicit writes through `ecs.write_observed`.
The application owns the semantic change witness and any derived state inside
its value. `insert_observed_resource_using` prepares ordinary replacements,
so restored or externally supplied values can rebuild their indices. Known
writes can retain those indices without comparing every source row. Ink owns
only the generic resource/revision mechanism; active pile sets, landing rules,
picture dependencies and staffing policy remain in the application.

`ecs/query` composes required, excluded, optional and alternative membership
terms. Its caller-owned cache records structural revisions separately from
payload writes; current typed read views supply values. `ecs/commands` commits
explicit typed component batches, while an application command interpreter
preserves order across spawn, despawn, resource writes and other operations.
`ecs/recipe` validates a caller-authored requirement graph once and fills missing
components using caller constructors, after explicit overrides.

`messages` is a bounded paged broadcast log with independent readers. `journal`
coalesces its collection changes without reserving an identity for reset.
Tracked ECS columns use this journal at mutation boundaries. Replacement,
retention gaps and entity topology changes request an explicit rebuild. Readers
and caches belong to the same snapshot lineage as their data; applications reset
them on restore or a switch to another lineage. No observers run synchronously
inside a component write. `relations` keeps typed forward edges and persistent
inverse sets together; the caller chooses cycle and deletion policy. These
mechanisms contain no application component vocabulary or gameplay rules.
