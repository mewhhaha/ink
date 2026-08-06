# @ink/ecs plan

Status: implemented.

## Purpose

Offer a reusable data-oriented world model without making an entity model part
of Ink's runtime or subsystem contracts.

## Ownership

This package owns generational entity allocation, typed components, singleton
resources, queries, change tracking, system access declarations, schedules, and
world snapshots. It does not own scene nodes, engine lifecycle, physics bodies,
render objects, networking authority, or game-specific components.

## Public contracts

- Opaque entity handles containing an index and generation.
- Declared component and resource schemas with stable identities and codecs.
- Sparse-set component storage, fixed-domain entities, dynamic allocation, and
  immutable query descriptions.
- Read/write access declarations, deterministic schedules, command buffers, and
  structural-change barriers.
- Change ticks and snapshots suitable for save, replay, hot reload, and
  replication adapters.

The dynamic allocator reuses freed indices in deterministic LIFO order and
increments their generation before reuse. Fixed domains expose every index at
generation zero and cannot spawn or despawn. Queries drive from the smallest
sparse set and retain that set's dense order. Snapshots sort schemas, stores,
and component rows by stable identity and entity index; restore accepts additive
current schemas but rejects missing or version-changed snapshot schemas.

## Dependencies and integration

Direct dependency: `@ink/observability`.

No core subsystem accepts an ECS entity as its primary identity. Scene,
rendering, physics, animation, audio, navigation, and networking may expose
adapter entry points that translate queries to their own input snapshots. The
current Blot ECS is the behavioral extraction source.

## Tasks

- [x] **ECS-001:** Define entity lifetime, schema identity, component/resource
      ownership, access declarations, and snapshot ordering.
- [x] **ECS-002:** Implement dynamic generational allocation and fixed-domain
      entities with stale-handle rejection.
- [x] **ECS-003:** Implement sparse-set components, resources, joins, dense
      cursors, mutation, removal, and change ticks.
- [x] **ECS-004:** Implement deterministic schedules from declared access,
      command-buffered structural changes, and explicit barriers.
- [x] **ECS-005:** Implement versioned schema digests, complete snapshots,
      compatible restore, and evidence-rich incompatibility results.
- [x] **ECS-006:** Port the proven Blot ECS behaviors through a Blot binding
      without making the TypeScript implementation authoritative for the guest.
- [x] **ECS-007:** Add empty/one/many, recycling, stale generation, sparse join,
      schedule conflict, structural mutation, snapshot, and reload tests.
- [x] **ECS-008:** Benchmark allocation, iteration, joins, churn, snapshot size,
      and change extraction before adding specialized layouts.

## Operational requirements

- Schema errors fail world construction; stale handles and expected missing
  components return typed results; broken storage invariants fail loudly.
- The package has no platform fallback. Schedule and snapshot failures cannot
  leave a partially committed structural change.
- World sizes, query spans, structural changes, schedule barriers, and snapshot
  timings emit observations without logging component payloads by default.
- Allocation reuse, query order, schedule order, command application, and
  snapshots are deterministic for the same build and inputs.

Schedules use stable first-fit conflict stages. Systems within a stage execute
in declaration order, and one transactional structural barrier follows each
stage. The Blot guest retains its native cell-backed ECS; only entity, schema,
and seed boundary encoding is shared with this package.

## Acceptance

Recycled indices never expose old components. Query order and system execution
are reproducible for one build. Read-only scopes cannot mutate. A snapshot
contains every entity, component, resource, allocator generation, and change
value required to continue the same world.
