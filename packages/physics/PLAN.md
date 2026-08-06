# @ink/physics plan

Status: implemented and verified.

## Purpose

Provide first-party collision, rigid-body simulation, queries, and character
movement behind a game-neutral world contract.

## Ownership

This package owns collision shapes, broadphase, narrowphase, contact manifolds,
rigid bodies, mass properties, forces, impulses, integration, islands, sleeping,
joints, triggers, continuous collision detection, queries, character movement,
and physics snapshots. It does not own scene transforms, terrain data, gameplay
damage, navigation policy, rendering, or networking authority.

## Planned contracts

- Stable world, body, collider, joint, and shape identities with generations.
- Sphere, capsule, box, convex hull, heightfield, and static triangle-mesh
  shapes; dynamic concave bodies are not supported.
- Fixed-step inputs and immutable outputs for poses, velocities, contacts,
  triggers, sleep transitions, and broken joints.
- Ray, shape-cast, overlap, and closest-point queries with masks and ignored
  identities.
- Versioned snapshots that preserve solver ordering, warm starts, sleep state,
  and allocator generations for same-build replay.

## Dependencies and integration

Direct dependencies: `@ink/math`, `@ink/geometry`, `@ink/scene`, `@ink/world`,
and `@ink/observability`.

Scene and terrain adapters exchange transforms and collision views. Animation
uses kinematic and ragdoll adapters. Navigation consumes queries. ECS and
networking integrations are optional adapters. No third-party physics backend
will be introduced.

## Tasks

- [x] **PHYS-001:** Define shape invariants, identities, motion types, units,
      filters, material combination, fixed-step, event, and snapshot semantics.
- [x] **PHYS-002:** Implement dynamic AABB-tree broadphase, collision filtering,
      pair persistence, islands, and sleeping.
- [x] **PHYS-003:** Implement primitive fast paths plus first-party GJK, EPA,
      SAT, manifold generation, and persistent contact caching.
- [x] **PHYS-004:** Implement mass properties, force and impulse integration,
      sequential impulse solving, friction, restitution, damping, and gravity.
- [x] **PHYS-005:** Implement fixed, hinge, ball, slider, spring, distance, and
      motorized joints with limits and break thresholds.
- [x] **PHYS-006:** Implement conservative continuous collision detection,
      sensors, ray and shape queries, and a kinematic capsule character mover.
- [x] **PHYS-007:** Implement heightfield/static-mesh adapters, origin rebasing,
      scene synchronization, snapshots, and observable solver diagnostics.
- [x] **PHYS-008:** Test stacks, slopes, tunneling, resting contacts, friction,
      restitution, mass ratios, joints, triggers, filters, character steps,
      rebasing, restore, and stale handles.
- [x] **PHYS-009:** Benchmark broadphase, narrowphase, solver iterations,
      queries, sleeping, and snapshot size against fixed fixtures.

## Operational requirements

- Invalid shapes, stale handles, unsupported dynamic concave geometry, and
  solver configuration errors return evidence-bearing failures at the boundary;
  broken solver invariants stop the world.
- Capacity and iteration limits use declared bounded policies and diagnostics;
  there is no alternate third-party backend or silent simulation fallback.
- Pair counts, contacts, islands, sleeping bodies, CCD work, solver residuals,
  query cost, capacity pressure, and step timings emit observations.
- Fixed-step body state, contacts, events, query ordering, sleep state, and
  snapshots are deterministic within the same engine build and numeric
  environment.

## Acceptance

The same fixed inputs and snapshot reproduce body, contact, event, and sleep
state within the same build. Invalid or stale identities never affect a new
body. Query results are ordered deterministically. Dynamic triangle meshes are
rejected with the body and shape identity in the error.

## Implemented package surface

- `identity.ts` provides world identity, generational handles, and allocator
  snapshots.
- `shapes.ts` provides validated sphere, capsule, box, convex hull, heightfield,
  and triangle-mesh definitions plus mass properties.
- `collision.ts` provides transformed bounds, primitive paths, support mapping,
  GJK, EPA, SAT, ray tests, closest points, and conservative shape sweeps.
- `world.ts` provides bodies, colliders, broadphase pairs, persistent contacts,
  fixed stepping, sequential impulses, islands, sleep, joints, sensors, CCD,
  ordered queries, character movement, rebasing, and replay snapshots.
- `adapters.ts` provides scene, terrain, ECS, and large-world exchange ports
  without transferring ownership of those systems into physics.

Collision manifolds deliberately expose one stable contact point per pair in
this first-party implementation. Static mesh and heightfield geometry stays
static and uses dedicated sphere contact paths; other convex shapes use the
shared support-mapped path. Shape casts use conservative swept bounds, so a
reported hit may precede exact surface contact but cannot silently tunnel past
the reported candidate.
