# Continue the owned-storage migration

## Current status

The named-function source migration covers all 325 Blot files: 3,506 module
functions now use named declarations. Qualified methods and explicit predicates
retain their checked interfaces; genuine function aliases, local closures and
implementation members remain values. Codecs/behavior/Pen fixtures are generated
from updated templates; codec helpers now use lowercase snake_case names and
all callers are migrated. Wire formats and saved versions are unchanged.

The complete frontend/API inventory passes 322 files plus three intended
rejections. Original stdlib and Ink codec export-emission gaps reproduce with
both old and migrated sources; they are not fresh runtime passes. Follow the
shared [migration evidence](../blot2/benchmarks/evidence/qualification/2026-11-08-named-source-migration.json)
for current compiler identities and pending release/Main qualification. Historical
runtime evidence below qualifies its named older candidates.

World/editor callbacks retain the concrete nominal hooks bundle and exact
closed effects. Gdev now uses a fixed nominal FrameAccess with proved physical
payload slicing; its ordered hand-copy replacements preserve the same consumer
and commit policy. The final release passes seven world/editor and 160 focused
hand checks in sync/JSPI. Fresh main takes 7.26–7.42s/22.35MB, cache disabled;
the five-second goal remains unmet. Exact compiler/source identities and all
qualification gaps live in
[Blot's current evidence](../blot2/zig-native/measurements/gdev-after-walks-and-bounds-2026-11-02.json).
No Ink library source changed in this batch. Installed Pen rejects ABI 8 before
rendering, so the current compiler has no new frame/PNG qualification.

Read `AGENTS.md`, `docs/architecture.md`, `docs/blot.md` and
[Blot's shared continuation](../blot2/CONTINUE.md). This is a greenfield
project; breaking changes are welcome and superseded APIs should be removed.

The library, examples, fixtures and performance sources now use current syntax
and named owners. A complete frontend/API inventory reported 322 passing files
and three intended semantic rejections; refresh it after edits. This checks
unused declarations, not original export emission or runtime assertions.

Checked original workloads include incremental ECS (1,435 assertions), sparse
restore with historical dead rows and malformed-packet rejection, navigation,
persistence, UI, steering, retained rendering and performance families. Preserve
all original sizes and independent numerical references.

The current native physics, scene, spline, numeric, boundary and numeric-stress
families pass 21 tests. Physics retains the original 600-tick 50/60-body cases.
All 56 complete prepared-physics replay comparisons passed. All 12 batch
comparisons now pass, including rigid/walker/joint modes at 2,048 fixed bodies.
Separate named Source/proxy owners remove simultaneous fixed-scratch copies;
math, original workload sizes and storage budgets are unchanged. All 56 complete
replay comparisons and all four original native physics tests also pass after
this owner-only followup (compiler `9902355f`). Original query/invalidation and
fixed-joint endpoint checks also pass.

The full Pen fixture passes all 13 original packet/UI/preference/command
entrypoints, 35 render-scale combinations and occlusion cases. Retained-instance
fixtures pass original packet/rejection laws and 16-frame workloads through
4,096 instances. See
[portable source, packet and numeric evidence](tools/audits/2026-10-31-owned-storage.json).
All nine performance adapter entries now pass 71 original workload/boundary
cases in both development/sync and optimized/async, including frame packets
through 4,096 instances. The reviewed compiler now lowers custom Codec/Format
methods. Original word persistence passes its complete corpus and all 260
truncated-input rejections.

An earlier reviewed compiler and matching host passed one actual Gdev native
Pen frame. All six checks pass; the inspected PNG and trace match the
original frame byte for byte. See
[the current exact result](../blot2/tasks/storage-handoff-evidence/2026-10-31-migrated-frame.json).
Recheck real integration after semantic changes. Full library/browser/release
and performance qualification remain open.

## Current ownership contract

Use `func`, explicit `return`, curried `->`, `$Constructor`, primitive booleans,
`and`/`or` and `#[...]` arrays. Lists use `[]`.

Declare mutable owners separately. `Array T` has fixed extent, `GrowArray T`
appends and `ResizeArray T` also shrinks. Store fixed rows and scalar spans into
separate payload owners. Supply destinations or a known consumer for temporary
multi-owner results; do not return fresh bundles of owners or carry fresh owners
through loops. Scene/physics intermediates and spline/path construction follow
this pattern. No owning compatibility factories remain.

Views, links and access records preserve aliases rather than snapshots.
Independently retained history, previous-state columns and worker packets need
explicit copies, including payloads referenced by spans. Keep borrows within the
owning invocation. Callbacks are compile-known; preserve actual latent effects
and concrete owner/read-result contracts at generic boundaries. Scalar callback
captures are values; use meaningful named mutable owners for shared counters.

ECS uses a live-entity owner, component pools and explicit metadata. Query,
command, journal, checkpoint and payload storage are caller-owned. Preserve
revision/epoch behavior, historical rows, deterministic math and contact order.
Geometry and render caches retain stored spans and separately named payloads.

ABI 8 and session protocol 2 remain fixed. Frame/UI/audio buffers live through
packet encoding. Host packets and worker jobs contain copied numeric data.
Checkpoint/restore is explicit; rejected presentation must not advance
simulation again. Language tasks are retired; host queues/workers remain.

## Verification and next work

Use the matching sibling Blot/Pen tools selected by `pen.json`. The compiler
plugin allows two hours for a cold request; prepared solver emission took about
ten minutes. This deadline changes no work, storage or engine limits.

```sh
pen tool ink -- fmt --check
pen tool ink -- generate tools/generate.json
pen test-blot tests/dialogs.blot
pen test-blot --filter navigation
pen test-blot
```

Generator freshness and Rust formatting passed for the current checked batch.
Run affected families after coherent changes. Use the shared migration auditor
for source inventory; report original export/runtime results separately.
Generate codecs and Pen bindings from their model/schema inputs. Do not
hand-edit output or remove assertions to pass migration.

Continue remaining original-export/compiler emission qualification and real Gdev
integration. Then run broader native/GPU/browser checks headlessly, with GPU
consumers sequential. Fresh performance measurements require a qualified
candidate; historical counted-storage timings do not measure this
implementation. Commit checked batches continuously to `main`, verify the remote
hash and retain concise evidence. Do not publish the environment.
