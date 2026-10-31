# Continue the owned-storage migration

Brush edge enumeration now uses one GrowArray and freezes once, preserving the
original plane-pair order. The former fixed-array rebinding loop reproduced a
scoped ownership rejection. A focused cube test passes twelve unique unit edges,
degree three at each vertex, independent outputs and the unchanged face pool in
both tiers and sync/async (four checks). The real Gdev frame remains pending.

The first-frame integration gives `map.locate` its exact `Maybe U32` result
signature. Without it, an early `$Nothing` in the probe loop reaches scoped
layout with an unresolved payload. All five U32/Vec4/SIMD/from/mixed probes
compile with the annotation. Existing collision/growth, independent-copy and
ordered-reinsert/frozen-map tests execute with zero failures in sync and async.
The real Gdev frame is still pending.

## Current cloud frontier

Brush drawing now uses canonical Stored/Face/Quat/Vec3/F32 locals and preserves
arithmetic order. The actual-main integration has moved beyond that diagnostic,
but this is not full library qualification.

No real main Wasm or Pen frame has passed. Resume the exact attempt, next
boundary and current compiler/test limitations in
[Blot's shared continuation](../blot2/CONTINUE.md#current-cloud-frontier) and
[tracked evidence](../blot2/tasks/storage-handoff-evidence/2026-10-30-cloud-main.json).
Keep shared integration details there instead of duplicating checkpoint logs.

## Current language and ownership contract

Use `func` and explicit `return`, curried `->` parameters, `$Constructor` tagged
data, `true` / `false`, and short-circuit `and` / `or`. Array literals use
`#[...]`; `[...]` denotes Lists. Old `fn`, `#Constructor`, `&&` and `||`
spellings are not the current source contract.

Declare mutable owners separately. `Array T` permits fixed-extent element
writes, `GrowArray T` permits append, and `ResizeArray T` also permits
shrinking. Rows are fixed data, tagged data or scalar spans into separately
named payload pools. Do not return a fresh record containing several owning
arrays or carry fresh array owners through a loop. Use caller-owned destinations
or a known consumer whose temporary owners remain alive for the entire call.

`&[T]` captures a borrowed range and length; `&T` names a place and `^T` is a
checked pool link. None copies payloads or extends a lifetime. A descriptor or
access-record assignment preserves aliases. Independently retained history,
previous-state columns and worker packets require explicit copies, including
payloads referenced by spans. Persistent rows must not store arbitrary views
into younger storage.

Callbacks and policies are known at compilation. Their captured owner aliases
must remain live; no runtime callable storage or general effect-handler model is
promised. Preserve real latent effect rows rather than annotating a callback
pure merely to satisfy integration. Concrete owner/read-result contracts are
needed before mutating rows obtained through a generic access parameter.

## Implemented source direction

ECS uses a named live-entity owner, separate component pools and explicit
metadata. Query scratch, command buffers, journals, checkpoint destinations and
payload storage are caller-owned. Despawn clears registered columns explicitly;
revision and epoch changes remain observable. The latest `ecs.read` lazy
`Maybe a` reader change is part of the current source, but has not qualified the
actual Gdev main path or the entire library.

Geometry, spatial caches, prepared physics, UI and retained rendering use flat
stored rows and separately named payload pools. Preserve deterministic math,
contact order, cache reuse and explicit dirty/revision behavior. The physics
rewrite with six explicit payload owners and its affected witnesses still need
execution and qualification; source migration alone is not a passing result.

A frame owns its output, UI, audio and payload buffers locally. Static stages
receive an alias record, emit into those buffers and encode before the owners
close. Borrowed draw/text/event data must remain within that lifetime.
Persistent render caches retain stored spans and payload owners, not frame
views. The Gdev integration now declares a structural frame-access contract at
its storage/stage boundary; it introduces no runtime world allocation.

Pen session protocol version 2 keeps explicit checkpoint/restore and
presentation acknowledgement behavior. A rejected presentation does not imply a
second simulation advance. Host worker jobs and data queues remain: jobs
exchange copied numeric packets with isolated guests and explicitly revisioned
contexts. Language `task` scope, spawn/join/spark/receive/cancel APIs are
retired; do not add a task compatibility facade.

Generated codecs and Pen bindings come from their model/schema/generator inputs.
Do not hand-edit generated outputs. The codec model uses flat span metadata and
separate payload sections; preserve existing word-width, signed-zero and wire
boundary assertions when adapting consumers.

## Evidence and next actions

A historical focused run passed 23 entrypoints across nine modules. That result
predates subsequent source/compiler changes and is not qualification of the
current checkout. Many migrated fixtures are source-written only. Preserve their
original names, checks and workload scales; distinguish written, compiled and
executed results in subsequent handoffs.

First resume the real Gdev main compile and actual one-frame Pen run with the
matching sibling compiler/host. Then execute coherent affected Ink families,
including the pending physics witnesses and changed ECS reader laws. Only after
those boundaries are stable expand to the remaining fixture inventory and fresh
performance measurements. Old counted/snapshot implementation timings do not
measure this implementation.

## Portable development commands

From this repository, use a built sibling Blot compiler and full Pen
installation as described in [README](README.md) and [testing](docs/testing.md).
`pen.json` selects compiler, standard library and aliases. Commands documented
here are continuation instructions, not checks performed for this handoff:

```sh
pen tool ink -- fmt --check
pen tool ink -- generate tools/generate.json
pen test-blot tests/dialogs.blot
pen test-blot --filter navigation
pen test-blot
```

Explicit `.blot` paths select Blot modules; `--filter` also applies to native
references. Run GPU witnesses headlessly. Use `pen tool ink -- bench` only after
correctness qualification, retaining numerical witnesses and source identities.
No ignored local build logs are required to understand this handoff.
