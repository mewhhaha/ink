# @ink/visibility plan

Status: implemented; rendering can supply delayed GPU results through the
revision-tagged occlusion contract.

## Purpose

Produce a conservative, explainable visible set before rendering work is
submitted, including large worlds and delayed GPU occlusion results.

## Ownership

This package owns visibility objects, frustum and distance culling, masks,
small-object policy, LOD selection, portals and rooms, occlusion tests, temporal
coherence, visible-set revisions, and culling diagnostics. It does not own scene
mutation, camera construction, draw batching, depth rendering, materials, or
gameplay line of sight.

## Planned contracts

- `VisibilityObject` containing stable identity, bounds, layers, LODs, occluder
  eligibility, and revision.
- `VisibilityContext` containing stable camera views, world partitions, quality
  policy, and previous conservative state.
- Visible and rejected records with reason, selected LOD, view membership, and
  source revision.
- Pluggable hierarchy, portal, and occlusion stages behind one ordered
  `VisibilityPipeline`.
- `OcclusionInput` carrying stable view matrices, zero-to-one depth convention,
  raster extent, conservative occluder geometry, object bounds, and an input
  revision. Backends return per-object states tagged with that revision.
- Explicit pending, unavailable, stale, and invalidated occlusion results; all
  uncertain states resolve to visible.

## Dependencies and integration

Direct dependencies: `@ink/math`, `@ink/geometry`, `@ink/scene`, `@ink/world`,
`@ink/camera`, and `@ink/observability`.

Rendering owns the WebGPU depth-pyramid adapter and returns revision-tagged
results through the occlusion contract. It also consumes the resulting visible
set. Existing unconditional scene batching is replaced only after visible-set
parity tests pass.

## Tasks

- [x] **VIS-001:** Define object bounds, view masks, culling reasons, LOD
      hysteresis, pipeline order, invalidation, and conservative guarantees.
- [x] **VIS-002:** Implement hierarchical frustum, distance, projected-size,
      layer, and world-partition culling with deterministic ordering.
- [x] **VIS-003:** Implement portal and room traversal with bounded recursion
      and fallback to ordinary spatial culling for incomplete connectivity.
- [x] **VIS-004:** Implement first-party software occlusion for headless and
      CPU-oriented fixtures.
- [x] **VIS-005:** Implement revision-tagged occlusion-result ingestion,
      temporal coherence, camera-cut invalidation, motion expansion, and
      newly-visible safeguards. Reduced resolution and numerical uncertainty
      bias the result toward visible.
- [x] **VIS-006:** Implement LOD selection and hysteresis shared by mesh,
      terrain, animation, and effect consumers.
- [x] **VIS-007:** Add exhaustive small-scene oracle tests plus camera cut, fast
      mover, near-plane, thin occluder, stale result, portal, and LOD tests.
- [x] **VIS-008:** Benchmark visible-set cost and rejected work across sparse,
      dense, indoor, terrain, and high-motion scenes.

## Operational requirements

- Invalid bounds or mismatched revisions are rejected with object and view
  identity. Backend errors mark affected occlusion results unavailable.
- Missing, stale, reduced-confidence, or failed occlusion always degrades toward
  visible; cheaper policies may retain extra objects but never hide uncertain
  ones.
- Stage timings, candidates, rejection reasons, selected LODs, stale results,
  and false-positive validation counts emit bounded observations.
- CPU stage ordering and LOD decisions are deterministic. Delayed GPU result
  arrival is correlated by revision and cannot change earlier frames.

## Acceptance

The visible set may contain false positives but never hides an object solely
because occlusion is missing, stale, uncertain, or invalidated. An exhaustive
oracle confirms all geometrically visible objects survive CPU stages. Every
rejection can be attributed to one policy and input revision.
