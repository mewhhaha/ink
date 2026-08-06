# @ink/geometry plan

Status: implemented.

## Purpose

Provide game-neutral shapes and spatial algorithms used by visibility, picking,
world partitioning, physics, navigation, and asset processing.

## Ownership

This package owns geometric primitives, bounds, intersections, distance queries,
mesh topology operations, and reusable acceleration structures. It does not own
scene nodes, camera policy, visibility decisions, rigid-body state, navmeshes,
mesh assets, or GPU buffers.

## Planned contracts

- `Ray`, `LineSegment`, `Plane`, `Triangle`, `Sphere`, `Capsule`, `Aabb`, `Obb`,
  and `Frustum` with parsed construction.
- Typed hit results carrying distance, position, normal, and feature identity.
- Containment and overlap classifications rather than ambiguous booleans where
  the distinction matters.
- Immutable mesh topology views and first-party normal, tangent, bounds, and
  adjacency generation.
- Static BVH and dynamic AABB-tree primitives with caller-owned payloads.

## Dependencies and integration

Direct dependency: `@ink/math`.

Assets uses mesh processing; scene and world use bounds; visibility, physics,
and navigation build policy on the query primitives. This package never imports
any of those consumers.

## Tasks

- [x] **GEO-001:** Define normalized shape invariants and reject empty,
      inverted, degenerate, or non-finite construction where the operation
      cannot give it a meaningful interpretation.
- [x] **GEO-002:** Implement point, ray, sweep, closest-point, containment, and
      overlap queries with documented boundary-contact behavior.
- [x] **GEO-003:** Implement frustum extraction and classification using the
      shared matrix convention.
- [x] **GEO-004:** Implement indexed triangle topology, normal and tangent
      generation, winding conversion, adjacency, and bounds calculation.
- [x] **GEO-005:** Implement deterministic static BVH construction and a dynamic
      AABB tree with insert, update, remove, query, and validation operations.
- [x] **GEO-006:** Add adversarial tests for parallel rays, coplanar geometry,
      zero-area triangles, large coordinates, touching bounds, and tree churn.
- [x] **GEO-007:** Establish query and build benchmarks used by visibility,
      physics, and asset acceptance suites.

## Operational requirements

- Untrusted or degenerate shapes fail during construction when no query can
  interpret them safely; query misses remain ordinary typed results.
- The package has no platform fallback and emits no observations.
- Shape queries and acceleration-structure builds are deterministic for the same
  ordered inputs.

## Acceptance

Every query defines whether touching counts as a hit and returns the same result
under equivalent input ordering. Acceleration structures return the same
candidate set as exhaustive queries. Tree validation detects broken parent,
height, and bound invariants with the affected node identity.
