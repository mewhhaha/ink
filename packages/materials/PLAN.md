# @ink/materials plan

Status: implemented; consumer cutover is documented and pending.

## Purpose

Describe physical and stylized surfaces independently of meshes, lights, and
render paths while compiling them into consistent renderer inputs.

## Ownership

This package owns material definitions and instances, canonical PBR parameters,
metallic-roughness and specular inputs, texture semantics, samplers, variants,
alpha modes, sidedness, surface feature combinations, and renderer-independent
material records. It does not own texture loading, lights, render passes, GPU
layouts, WGSL compilation, mesh geometry, decals, or game-specific terrain
rules.

## Planned contracts

- Stable `MaterialDefinitionId` and `MaterialInstanceId` values with immutable
  definitions and bounded instance overrides.
- Canonical linear-light parameters for base color, metallic, roughness,
  specular level/tint, normal, occlusion, emissive, clearcoat, transmission,
  thickness, index of refraction, and alpha.
- Texture bindings carrying color space, UV set, transform, channel mapping,
  sampler, and fallback.
- Feature keys and validated variants that describe required surface behavior
  without embedding arbitrary game-authored shader source.
- Conversion of imported metallic-roughness and specular workflows to one
  render-path-independent representation.

## Dependencies and integration

Direct dependencies: `@ink/math`, `@ink/assets`, and `@ink/observability`.

Lighting defines the reference physical response. Rendering consumes material
records and owns their GPU layout, WGSL implementation, pipeline, and resource
lifetime. World and visual effects compose material instances through adapters.
The current color, emissive, texture, blend, path, and surface-mode fields are
migration fixtures rather than the target contract.

## Tasks

- [x] **MAT-001:** Define linear/sRGB boundaries, parameter ranges, texture
      semantics, alpha modes, sidedness, variants, and invalid combinations.
- [x] **MAT-002:** Implement canonical PBR definitions, instances, bounded
      overrides, feature keys, fallback references, and serializable canonical
      records.
- [x] **MAT-003:** Implement metallic-roughness and specular workflow import,
      including dielectric F0, tint, roughness, energy conservation, and
      conversion tests.
- [x] **MAT-004:** Implement normal, occlusion, emissive, clearcoat,
      transmission, thickness, and index-of-refraction features shared by all
      render paths.
- [x] **MAT-005:** Implement validated stylized extensions without allowing them
      to alter core depth, identity, or semantic behavior.
- [x] **MAT-006:** Implement material hot replacement and instance revision
      propagation; rendering decides which GPU records and pipelines those
      revisions invalidate.
- [x] **MAT-007:** Add parameter-boundary, color-space, normal orientation,
      workflow conversion, variant, fallback, replacement, and reference-sphere
      tests.
- [x] **MAT-008:** Measure canonical record size, instance update cost, import
      conversion, and feature-key cardinality.

## Operational requirements

- Out-of-range parameters, conflicting features, missing required texture
  semantics, and invalid imported workflows fail while naming the definition and
  fields.
- Missing optional textures use declared typed fallbacks; an unsupported feature
  selects a validated lower feature variant or rejects the material before
  rendering.
- Definition and instance counts, feature keys, fallback use, replacement
  failures, and conversion warnings emit structured observations through the
  consumer boundary.
- Canonical records, workflow conversion, feature keys, and reference evaluation
  are deterministic; final raster output is not package state.

## Acceptance

Compatibility, clustered-forward, and deferred paths consume the same canonical
material instance. Metallic-roughness and specular fixtures preserve their
intended F0 and roughness response. Invalid combinations fail while naming the
definition and conflicting features; missing textures use typed fallbacks.
