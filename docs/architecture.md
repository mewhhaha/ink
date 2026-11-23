# Package boundary

Ink is a Blot source library under `lib/`, imported through a caller's `ink/`
alias. It supplies reusable calculations, simulation, typed component pools,
scheduling, codecs, persistence, input, presentation and headless editing tools.
Core modules depend only on Ink and Blot's standard library. Applications own
assets, vocabulary, configuration, loops and storage lifetime. Pen is an
optional host, not part of the core library.

The owned-storage migration is in progress. The APIs below describe the new
source contract; integrated compiler and application qualification is still
pending. Old snapshot-world examples and performance fixtures are being ported.
Their previous timings do not measure this implementation.

## Named owners and explicit copies

Each mutable pool has a separately named owner. Access records alias existing
owners for a call; they do not allocate a world or preserve an earlier version.
Use `#[...]` for all array literals and choose `Array`, `GrowArray` or
`ResizeArray` in the type. Fixed arrays allow element writes, growing arrays
allow append, and resizing arrays additionally allow shortening. Lists use
`[...]` and have explicit copy operations.

Rows contain scalars, fixed records, tagged data or spans into separate payload
pools. Long-lived rows use stable IDs and `{start, count}` spans. They cannot
contain owning nested arrays. A `&[T]` view captures a range in an existing owner;
it does not copy its elements or extend its lifetime. A `&T` reference names a
place, and a `^T` link retains checked owner identity. Neither is a snapshot.

Copying is an operation. An independent checkpoint supplies a destination pool
and, for payload spans, a policy that copies the corresponding payloads too.
Assigning an access record or a descriptor keeps its aliases. Replacements and
restores invalidate transient caches explicitly; there is no reference counting,
copy-on-write world or implicit simulation rollback in the target runtime.

## Collections and simulation

ECS state consists of a live-entity pool, separate typed component pools and
separate revision metadata. Entity IDs increase monotonically within an epoch.
A payload write changes its payload revision; adding or removing membership
changes the structural revision. The application's static schema clears its
registered columns on despawn and supplies previous-state copies when needed.
Query keys, selected IDs and build metadata belong to the caller. Structural
commands commit at explicit boundaries; no provider or observer runs hidden
inside a write.

Maps and sets use insertion-ordered flat rows plus independent hash buckets.
Callers supply compile-known hash and equality policies. Edits mutate these
owners; retaining an earlier map requires an explicit copy. Messages and
journals use bounded data pools with explicit reader cursors and reset signals.
Data job queues remain ordinary owned state.

Scene geometry has independent point, plane, ring, index, height and source-plane
pools. Persistent proxy rows retain spans into those pools. Scene updates receive
explicit dirty indices and overwrite reusable geometry where its extent is
unchanged. Spatial indexes refit caller-owned storage. Prepared physics retains
explicit geometry, lineage and revision identities; it does not retain a whole
world. Numerical, collision-order and deterministic gameplay rules remain part
of the library's behavior contracts.

## Static application stages and frame lifetime

An application composes known reset, start, normalization, checkpoint, input,
update, render and settle functions. Each receives explicit access to its state.
Policies and callbacks are known at compilation; runtime function registries,
general effect providers and language tasks are outside this profile.

A frame declares its output and payload pools locally, binds them into an
invocation access record, runs the stages and encodes the result before those
owners close. Draws, UI nodes and text may borrow these frame pools. Only copied
numeric packet data crosses the host boundary. Persistent render caches instead
keep stored rows, spans and separate payload owners, copying their presentation
into a frame when needed. Retained rendering keeps stable instance IDs and emits
explicit changes; dirty UI preparation retains its topology and revision logic.

Saves encode named sections into a numeric payload owner. Decode and restore
write caller-owned state and then normalize it. Snapshot, restore and replay are
explicit operations. A renderer may reject its transaction without undoing the
simulation step; session protocol version 2 distinguishes these outcomes so a
retry does not advance simulation twice.

## Hosts, workers and tools

`lib/pen/` translates Ink data into Pen's generated wire format. Pen's generator
and runtime import no Ink or game modules. Pen owns compilation, transport,
platform services, GPU resources and audio playback. Five core WGSL shaders have
host-neutral binding contracts in [shaders.md](shaders.md).

The sky's light is calculated here and consumed there: each frame the adapter
projects `graphics.sky` onto nine spherical-harmonic terms (`environment`,
`graphics.ambient`) and sends them with a reflection tint in the render packet's
sky. Pen only evaluates them and prefilters its own cube map of the same
gradient; a later per-position source (an irradiance probe grid) replaces that
evaluation inside Pen's `ambient_light(world, normal)` without any change here
beyond the data it would send.

Pen worker jobs exchange copied numeric buffers with isolated guests. Prepared
worker sessions retain explicitly revisioned contexts and join ordered results.
They do not share mutable application owners. Language-level task captures and
suspended task storage are removed from the target profile. Ordinary Foreign
calls and host suspension keep their invocation alive until settlement.

Tests and tools stay outside the source package. Run `pen test-blot` for Blot and
native reference witnesses, and `pen tool ink -- bench` for measured workloads.
GPU checks run headlessly. Generators own their outputs: change the model or
template, then regenerate. Consumers can export the library, shaders, examples,
documentation and content inventory with `pen tool ink -- pack DIR`.
