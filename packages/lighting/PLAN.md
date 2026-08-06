# @ink/lighting plan

Status: implemented; consumer cutover is documented and pending.

## Purpose

Provide consistent direct, shadowed, image-based, and environmental lighting for
every PBR render path.

## Ownership

This package owns light identities and types, units, clustered assignment,
shadow views and atlases, probes, environment maps, image-based lighting,
atmosphere, exposure inputs, and first-party BRDF evaluation. It does not own
materials, cameras, visibility policy, render graph resources, authored weather
simulation, or baked-light authoring UI.

## Planned contracts

- Directional, point, spot, rectangular, and environment lights with physical
  units, masks, shadow policy, bounds, and revisions.
- Per-view clustered light lists with deterministic overflow and diagnostics.
- Directional cascades, spot shadows, point shadows, atlas allocation, bias,
  filtering, cache invalidation, and quality profiles.
- Irradiance and reflection probes, light maps, environment prefiltering, and a
  split-sum image-based lighting representation.
- Renderer-independent diffuse and microfacet specular reference functions,
  clustered-light plans, shadow-view plans, exposure, and atmospheric inputs.

## Dependencies and integration

Direct dependencies: `@ink/math`, `@ink/geometry`, `@ink/assets`, `@ink/scene`,
`@ink/camera`, `@ink/visibility`, `@ink/materials`, and `@ink/observability`.

Rendering consumes these records and owns WGSL, GPU layouts, shadow passes, and
path integration. World may supply environment and baked probe data. Visual
effects may emit lights through the same contract. The existing single
directional toon light is the initial migration fixture.

## Tasks

- [x] **LIGHT-001:** Define light units, ranges, masks, shadow settings, probe
      volumes, environment priority, exposure, and quality profiles.
- [x] **LIGHT-002:** Implement first-party Lambertian and energy-conserving
      microfacet specular reference functions with material reference tests.
- [x] **LIGHT-003:** Implement reference clustered assignment and a
      renderer-independent clustered-light plan with bounded overflow and
      per-view observations.
- [x] **LIGHT-004:** Implement directional cascades, spot and point shadow
      projections, logical atlas allocation, cache invalidation, bias, and
      filtering inputs.
- [x] **LIGHT-005:** Implement irradiance, reflection probes, light maps,
      environment import/prefiltering, image-based lighting, and blending.
- [x] **LIGHT-006:** Implement atmosphere and exposure inputs shared by all
      render paths without putting weather simulation in core.
- [x] **LIGHT-007:** Publish identical light, cluster, environment, and shadow
      plans for compatibility, clustered-forward, and deferred rendering.
- [x] **LIGHT-008:** Add inverse-square, cone, BRDF, cluster boundary, overflow,
      cascade partition, logical atlas, probe blend, and invalidation tests.
- [x] **LIGHT-009:** Profile reference light assignment, cluster and shadow-plan
      construction, probe processing, and environment prefiltering under
      representative light counts.

## Operational requirements

- Invalid light units, ranges, shadow settings, probe volumes, and environment
  inputs fail before a lighting plan is published.
- Quality pressure degrades shadow resolution, update frequency, probe count,
  and light count by declared stable policy; overflow is never silent.
- Light and cluster counts, overflow, shadow/probe invalidation, plan cost, and
  quality reductions emit structured observations.
- Reference BRDF, cluster membership, atlas planning, cascade selection, probe
  blending, and invalidation are deterministic for the same inputs.

## Acceptance

Reference evaluation produces the expected diffuse, roughness, metallic, and
specular response. Cluster overflow is deterministic and visible in diagnostics.
Shadow invalidation plans respond to light, caster, camera-cascade, and quality
changes without retaining stale revisions. Cross-path image parity is accepted
by `@ink/rendering` and the root graphics slice.
