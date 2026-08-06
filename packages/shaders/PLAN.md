# @ink/shaders plan

Status: implemented; renderer adoption is a separate migration.

## Purpose

Provide renderer-independent WGSL modules and reflection contracts that can be
validated, composed, diagnosed, varied, and hot-reloaded deterministically.

## Ownership

This package owns stable shader module identities, source and dependency
declarations, exported symbols, overrides, bindings, entry points, variant keys,
source maps, compiler-diagnostic translation, replacement decisions, and
reusable WGSL libraries. It does not own GPU devices, native shader compilation,
bind groups, pipelines, render passes, material instances, or asset residency.

## Contracts

- Immutable `WgslModule` values validated against their declared WGSL evidence.
- Deterministic topological composition with missing-dependency, cycle, exported
  symbol, override, binding-slot, and entry-point diagnostics.
- Typed, bounded shader variant schemas producing canonical stable keys.
- Generated-to-module source maps and evidence-bearing diagnostic translation.
- Structural hot-reload decisions that separate source recomposition from
  consumer interface rebuilds and include the dependent closure.
- Device-free `ShaderProgramContract` values for rendering consumers.
- Reusable transforms, BRDF/PBR, shadows, fog/sky, terrain, and
  debug/post-processing WGSL modules.
- A downstream adapter for `@ink/noise`'s source modules, with declared hash,
  gradient, cellular, value, and fractal dependencies and symbols.

## Dependencies and integration

The only direct dependency is `@ink/noise`, consumed downstream through its
public source-only WGSL contract. Noise does not depend on shaders. Rendering
and shader-graph consume this package; neither GPU nor graph concepts point back
into it. Native WGSL compilation and pipeline invalidation remain renderer work.

## Tasks

- [x] **SHADER-001:** Define validated module, dependency, symbol, override,
      binding, entry-point, and renderer-consumption contracts.
- [x] **SHADER-002:** Implement deterministic dependency composition, cycle and
      collision evidence, source maps, and diagnostic translation.
- [x] **SHADER-003:** Implement typed variant schemas and canonical keys.
- [x] **SHADER-004:** Implement structural hot-reload replacement decisions and
      transitive dependent invalidation.
- [x] **SHADER-005:** Supply reusable transforms, PBR/BRDF, shadow, fog/sky,
      terrain, debug, and post-processing WGSL modules.
- [x] **SHADER-006:** Add malformed declaration, cycle, collision, variant,
      source-map, replacement, and reusable-composition tests.
- [x] **SHADER-007:** Benchmark full reusable composition and variant-key
      resolution.
- [x] **SHADER-008:** Adapt `@ink/noise` WGSL modules downstream without
      introducing an upward dependency from noise.

## Operational requirements

All invalid module evidence names the module and offending declaration. Module
and dependency ordering, composed text, source maps, variant keys, and affected
replacement closures are deterministic. GPU compilation diagnostics remain an
external renderer input and are translated without hiding unmapped lines.

## Acceptance

The same input modules compose byte-for-byte regardless of registry order.
Cycles and interface collisions fail with involved module identities. Compiler
line diagnostics map to original module lines. Source-only changes recompose all
dependents, while binding, entry, override, or exported-symbol changes require
consumer rebuilds. All reusable modules compose without any WebGPU type or
state.

## Implementation

Validation intentionally checks declared WGSL evidence rather than pretending to
replace a standards-compliant WGSL parser. Rendering remains responsible for
native compiler validation and passes its messages back through the source map.
Composition emits dependencies before dependents and never rewrites module
source, keeping diagnostics and hot reload understandable.
