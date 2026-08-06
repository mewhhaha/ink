# @ink/visual-effects plan

Status: implemented and verified.

## Purpose

Compose transient visual simulations such as particles, trails, and decals
without turning them into scene-authoritative gameplay state.

## Ownership

This package owns effect identities, emitter definitions and instances,
particles, trails, ribbons, billboards, decals, pooling, CPU/GPU simulation,
bounds, collision inputs, lifetime, and deterministic seeds. It does not own
gameplay damage, permanent scene objects, materials, renderer post-processing,
physics authority, or audio effects.

## Planned contracts

- Immutable emitter graphs with shape, rate, burst, lifetime, spawn, update,
  render, material, bounds, and capacity modules.
- Runtime effect instances with stable identity, seed, time, quality budget,
  visibility bounds, and explicit stopped/finished states.
- CPU reference and WebGPU simulation backends consuming the same definitions.
- Billboard, mesh-particle, ribbon, trail, and decal render extraction.
- Optional depth, world-query, and collision inputs that degrade to no collision
  rather than taking ownership of physics state.

## Dependencies and integration

Direct dependencies: `@ink/math`, `@ink/geometry`, `@ink/assets`, `@ink/scene`,
`@ink/rendering`, `@ink/materials`, `@ink/lighting`, and `@ink/observability`.

Visual effects publishes conservative bounds. Application composition maps them
to visibility objects and may supply data-only depth, world, or physics query
ports without introducing reverse package dependencies. ECS support follows the
root adapter rule.

## Tasks

- [x] **VFX-001:** Define emitter modules, instance lifecycle, capacity,
      deterministic seeding, bounds, quality scaling, and failure policy.
- [x] **VFX-002:** Implement a CPU reference simulator for rate, bursts,
      lifetime, forces, curves, color, size, rotation, and sprite animation.
- [x] **VFX-003:** Implement first-party WebGPU particle simulation with bounded
      buffers, prefix/compaction operations, indirect draw counts, and readback
      limited to diagnostics.
- [x] **VFX-004:** Implement billboards, mesh particles, ribbons, trails, and
      projected decals through rendering and material contracts.
- [x] **VFX-005:** Define optional data-only depth, terrain, and collision query
      ports with documented deterministic limits; application composition owns
      adapters to world and physics.
- [x] **VFX-006:** Implement pooling, offscreen policy, quality budgets, device
      loss recovery, and hot replacement.
- [x] **VFX-007:** Test seed replay, bursts, capacity, zero lifetime, bounds,
      CPU/GPU conformance, pool reuse, offscreen policy, and device loss.
- [x] **VFX-008:** Profile simulation, compaction, upload, overdraw, and memory
      under mixed effect fixtures.

## Operational requirements

- Malformed emitter graphs and exhausted required resources fail before starting
  an instance; capacity exhaustion follows declared deterministic drop policy.
- Missing collision, depth, or GPU capabilities selects declared no-collision,
  CPU, reduced-quality, or stopped behavior without affecting gameplay
  authority.
- Spawn/drop counts, active particles, simulation cost, bounds, pool pressure,
  overdraw, capability loss, and replacement failures emit observations.
- CPU lifecycle, seeds, capacity, and effect events are deterministic. GPU
  particle positions are visual state and may vary within documented tolerance.

## Acceptance

CPU and GPU backends agree on lifecycle and bounded-capacity behavior; visual
positions may differ only within documented floating-point tolerance. Exhausted
capacity drops particles deterministically and reports the count. Device loss
does not affect gameplay state and effects restart or finish according to their
declared recovery policy.

## Implemented surface

- `definition.ts` validates immutable effect graphs and their declared failure,
  quality, capacity, bounds, offscreen, and recovery policies.
- `simulation.ts` is the deterministic CPU reference. Seed, rate, burst,
  lifetime, and capacity results are exact. Integrators using another
  floating-point backend should keep position and velocity within `1e-5` of this
  reference for fixtures that do not query external collision inputs.
- `gpu.ts` publishes bounded buffer layouts, WGSL compute kernels, ordered
  rendering-graph passes, indirect argument storage, and a dispatch port. The
  built-in GPU-facing backend executes the shared lifecycle model and delegates
  device commands through that port. Its only permitted readback is the 16-byte
  active/dropped/dispatch diagnostics record; the package never labels an
  unexecuted plan as GPU work.
- `extraction.ts` produces billboard, mesh, grouped ribbon/trail, projected
  decal, material, and bounded transient-light inputs without adding them to
  authoritative scene state.
- `runtime.ts` owns publication, startup, pooling, offscreen scheduling, atomic
  hot replacement, and device-loss routing.

Collision ports are synchronous data queries. An adapter must return the same
first contact for the same motion query and stable particle sequence if replay
determinism is required. Query ordering is emitter order followed by stable
particle sequence. Missing ports either mean no collision or reject startup, as
declared by the definition; visual effects never infer gameplay contacts.
