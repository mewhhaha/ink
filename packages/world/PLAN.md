# @ink/world plan

Status: implemented and verified.

## Purpose

Scale scenes beyond one resident hierarchy by owning level composition,
partitioned terrain, streaming, and large-coordinate policy.

## Ownership

This package owns level identities, cells and chunks, spatial partitions,
spatial demand and residency budgets, terrain data, terrain editing, vegetation
placement, and origin rebasing. It does not own byte transfer, asset caching,
scene-node behavior, asset decoding, visibility policy, terrain shading, rigid
bodies, navmeshes, or genre-specific map rules.

## Planned contracts

- `WorldId`, `LevelId`, `CellId`, chunk coordinates, global positions, and local
  origin values.
- Immutable partition and terrain descriptors with height, surface, hole,
  detail, and authored-region layers.
- A residency coordinator that turns spatial demand into priority asset lease
  requests and attaches complete cell scenes. Assets owns transfer, caching,
  cancellation, and hot replacement beneath those leases.
- Deterministic origin-shift events consumed by scenes and spatial systems.
- First-party terrain import, editing, chunk meshing, seam, and LOD data.
- `VegetationPlacementInput` carrying an explicit seed, generator version,
  region revision, density layers, and exclusion masks; stable instance
  identities derive only from those inputs.

## Dependencies and integration

Direct dependencies: `@ink/math`, `@ink/geometry`, `@ink/assets`, `@ink/scene`,
and `@ink/observability`.

Visibility consumes partitions; rendering consumes generated terrain batches;
physics and navigation consume terrain query views. Existing isometric tilemap
and terrain data are useful fixtures but do not define the general contract.

## Tasks

- [x] **WORLD-001:** Define global/local coordinates, partition identity,
      residency, streaming priority, budget, and origin-shift invariants.
- [x] **WORLD-002:** Implement grid and authored-volume partitions with
      deterministic scene attachment and detachment.
- [x] **WORLD-003:** Implement spatial demand, prefetch, bounded residency, and
      failure retention by acquiring and releasing `@ink/assets` leases; do not
      implement a second transfer or asset cache.
- [x] **WORLD-004:** Implement terrain layers, editing, chunk meshing, normal
      generation, cracks and seams, geometric LOD, and query sampling.
- [x] **WORLD-005:** Implement deterministic vegetation placement and stable
      instance identities without making ecology or gameplay part of core.
- [x] **WORLD-006:** Implement origin rebasing across resident scenes with one
      ordered event consumed by camera, visibility, rendering, physics, audio,
      and navigation adapters.
- [x] **WORLD-007:** Test crossing boundaries, cancellation, failed chunks,
      eviction, seams, edits, negative coordinates, rebasing, and save/restore.
- [x] **WORLD-008:** Benchmark traversal and residency under large static,
      moving-camera, edited-terrain, and memory-pressure fixtures.

## Operational requirements

- Malformed partitions, terrain, or cell metadata fail before attachment.
  Missing or failed assets leave the cell unavailable or on its last complete
  revision.
- Budget pressure degrades by deterministic priority and LOD policy; it never
  publishes a partially resident cell.
- Demand, lease state, residency, eviction, terrain rebuilds, rebases, bytes,
  and budget pressure emit structured observations.
- Partitioning, terrain generation, vegetation identity, demand ordering, and
  rebase events are deterministic for the same seed, versions, and inputs.

## Acceptance

A chunk becomes visible to consumers only after its dependencies and scene
snapshot are complete. Failed streaming retains the last usable revision.
Rebasing preserves global positions and relative local positions without
changing deterministic gameplay state. Adjacent terrain LODs have no cracks.
