# @ink/scene plan

Status: implemented; development's preview hierarchy now consumes the shared
scene resolver through a flat-command adapter.

## Purpose

Represent spatial composition once so rendering, UI, animation, physics, audio,
and world streaming can observe the same hierarchy without sharing their
internal state. A saved scene is also the reusable composition primitive.

## Ownership

This package owns scene and node identities, local/world transforms, hierarchy,
activation, layers, typed opaque attachments, snapshots, deltas, and scene
serialization. It does not own entities, cameras, meshes, materials, culling,
physics bodies, semantic widgets, or level streaming.

Nested scenes retain their source scene and source node identities. Edits made
inside an instance are serialized as local overrides; Ink has no separate prefab
concept.

## Planned contracts

- Stable `SceneId` and `SceneNodeId` values distinct from ECS and asset
  identities.
- Parsed local transforms and parent operations that reject cycles.
- Resolved immutable `SceneSnapshot` values with world transforms, inherited
  activation, layers, revisions, and optional bounds.
- Ordered `SceneDelta` operations for incremental consumers.
- Namespaced attachment keys whose payload codecs live in the owning subsystem.

## Dependencies and integration

Direct dependencies: `@ink/math`, `@ink/geometry`, `@ink/assets`, and
`@ink/observability`.

World composes scenes. Camera, visibility, rendering, UI, animation, physics,
and audio consume snapshots or deltas. ECS support is an optional adapter. The
existing Blot scene hierarchy and WebGPU transform resolution are extraction
inputs.

## Tasks

- [x] **SCENE-001:** Define identity, hierarchy, activation, layer, attachment,
      snapshot, revision, and serialization invariants.
- [x] **SCENE-002:** Implement node creation, removal, reparenting, and local
      transform changes with early cycle and stale-identity errors.
- [x] **SCENE-003:** Implement topologically ordered world-transform, inherited
      activation, bounds, and revision resolution.
- [x] **SCENE-004:** Implement immutable snapshots and ordered deltas so
      consumers can rebuild or update incrementally from the same authority.
- [x] **SCENE-005:** Implement versioned serialization with asset references and
      registered attachment codecs.
- [x] **SCENE-006:** Move generic scene hierarchy behavior out of Blot and
      development through language and renderer adapters.
- [x] **SCENE-007:** Add deep, wide, removed-parent, cycle, reparent, inactive,
      layer, delta, and serialization tests.
- [x] **SCENE-008:** Benchmark hierarchy resolution and delta consumption under
      static, animated, and streamed-scene churn.
- [x] **SCENE-009:** Instantiate single-root scenes inside other scenes with
      stable instance identities, source ownership, and serialized local
      overrides.

## Operational requirements

- Unknown nodes, stale revisions, attachment codec failures, and parent cycles
  return evidence-bearing failures before a snapshot is published.
- A failed delta or attachment decode retains the previous complete snapshot;
  the package has no other platform fallback.
- Resolution cost, node counts, hierarchy depth, changed nodes, and
  serialization failures emit bounded observations.
- Hierarchy resolution, inherited state, delta ordering, and serialization are
  deterministic for the same inputs.

## Acceptance

Cycle attempts identify the complete offending parent path. Removing or
reparenting nodes produces an ordered delta that cannot expose a child with an
unknown parent. Full rebuild and incremental consumption produce identical
resolved snapshots.
