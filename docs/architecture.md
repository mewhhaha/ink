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

`lib/pen/` is an optional Blot adapter. It translates Ink values to generated
`pen/` wire records and back. Pen generates and owns those records and imports
no Ink or game modules. Pen owns compilation, transport, native services,
rendering and audio playback. Other hosts can supply their own adapters without
changing core Ink.

`mod.ts` is the minimal source locator and installer: `libraryUrl`, `modules`
and `installLibrary`. Local consumers map their compiler alias to `libraryUrl`;
HTTP consumers install the sources into a directory before native compilation.
It contains no game runtime or platform integration.

The distribution ships Blot modules, five standalone core WGSL shaders, Blot
examples, documentation and the source installer. The
[shader contracts](shaders.md) define bindings and vertex layouts; callers own
the renderer and GPU resources. Tests pack the sources with Deno, check their
boundary and compile the installed Blot modules from isolated HTTP and Node
consumers.

Sources install recursively, including namespaces such as `ui/`, `input/`,
`navigation/` and the optional `pen/` adapter. Importing core modules does not
require Pen bindings. The independent ECS example also compiles from an
installed HTTP or Node package without a sibling checkout.

Tests and tools remain outside the published package. `tools/setup.ts` caches
the pinned upstream Blot compiler and standard library in `.cache/blot/`. Tests
compile handwritten fixtures directly with upstream `createCompiler` and
`instantiateGuest`. The optional `pen.json` runs self-contained Blot check
modules through Pen's compiler plugin and native Wasm host, without a game entry
or renderer. It does not replace the Deno packaging, JavaScript reference or V8
checks. Both runners use the same handwritten Blot test sources. Benchmarks
measure every module, scaling, replay and memory growth while retaining
numerical witnesses.

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
`tools/derive.ts` uses the pinned upstream checker and generator; its generated
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

`spatial/points` performs exact nearest-point queries in the floor plane, with
source indices breaking ties. Applications keep the index with its positions and
rebuild it on movement or membership changes.

Native Pen's optional `pen/workers` callback submits bounded numeric batches to
isolated guest instances. The module supplies a pure `plan` entry; all results
join in submission order before the call returns. Mutable worlds and structured
task continuations never cross this boundary. Applications decide whether a
batch is large enough to justify copying and worker startup; the browser host
does not offer this native callback.

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
