# @ink/animation plan

Status: implemented and verified.

## Purpose

Evaluate authored motion into reusable pose and property outputs for scenes,
rendering, physics, and gameplay adapters.

## Ownership

This package owns skeletons, clips, tracks, pose evaluation, blending, masks,
state graphs, constraints, inverse kinematics, morph weights, root motion,
events, compression, and skinning inputs. It does not own mesh rendering,
physics authority, gameplay state machines, asset transport, scene hierarchy, or
character controls.

## Planned contracts

- Validated skeletons with stable joint identities, parent order, bind pose,
  inverse bind matrices, and retarget metadata.
- Typed transform, scalar, morph, and event tracks with interpolation.
- Immutable clips, blend trees, layers, masks, state graphs, parameters,
  transition rules, and runtime state snapshots.
- Pose, root-motion delta, morph weights, and ordered event outputs for a
  supplied deterministic time step.
- Two-bone IK, look-at, aim, and bounded constraint operations.

## Dependencies and integration

Direct dependencies: `@ink/math`, `@ink/assets`, `@ink/scene`, and
`@ink/observability`.

Rendering consumes skin matrices and morph weights through its downstream
adapter. A specialized editor or application owns bidirectional ragdoll
composition with physics. ECS support is optional and follows the root adapter
rule. Asset glTF animation output is the first import path.

## Tasks

- [x] **ANIM-001:** Define skeleton, track, clip, event, pose, graph, root
      motion, and snapshot invariants.
- [x] **ANIM-002:** Implement step, linear, spherical, and cubic track sampling,
      clip looping, event traversal, and pose construction.
- [x] **ANIM-003:** Implement blend trees, additive layers, masks, state graphs,
      transition interruption, synchronization, and parameter updates.
- [x] **ANIM-004:** Implement root motion, two-bone IK, look-at, aim,
      constraints, retargeting metadata, and morph output.
- [x] **ANIM-005:** Implement first-party track compression with measured error
      thresholds and deterministic decompression.
- [x] **ANIM-006:** Integrate scene transforms, hot replacement, and snapshots;
      publish pose and morph outputs consumed by rendering and application-owned
      ragdoll composition.
- [x] **ANIM-007:** Test empty/one/many joints, loop boundaries, reverse
      playback, event crossings, transitions, masks, IK limits, root motion,
      restore, and malformed skeletons.
- [x] **ANIM-008:** Benchmark graph evaluation, pose blending, skin generation,
      compression, and crowds.

## Operational requirements

- Invalid skeletons, tracks, graphs, constraints, and references fail during
  parsing with the asset and joint or state identity.
- Missing optional tracks use bind/default values; missing mandatory skeleton or
  clip data prevents the animation instance from starting.
- Active states, transitions, sampled joints, events, compression error,
  evaluation cost, and replacement failures emit bounded observations.
- Graph transitions, sampling, poses, root motion, and event order are
  deterministic from snapshot, parameters, and time step within one build.

## Acceptance

The same graph state and time step produce the same pose, root-motion delta, and
ordered events within one build. Invalid skeleton cycles or joint references
fail during parsing. Restoring a graph snapshot continues without repeating or
dropping boundary events.

## Implemented package surface

- `skeleton.ts` validates parent-ordered skeletons, stable joint identities,
  bind matrices, and retarget semantics.
- `clip.ts` provides typed transform, scalar, morph, and event tracks; step,
  linear, spherical, and cubic sampling; deterministic loop/reverse traversal;
  root motion; and measured key reduction.
- `pose.ts` provides immutable poses, masks, ordinary and additive blending,
  hierarchy and skin matrices, retargeting, two-bone IK, look-at, and aim.
- `graph.ts` provides recursive blend nodes, additive layers, parameters,
  prioritized interruptible transitions, synchronization, hot replacement,
  observations, and replay snapshots.
- `adapters.ts` provides scene transform writes, rendering skin/morph outputs,
  application-owned ragdoll composition, ECS publication, and a decoded glTF
  animation boundary without taking ownership of consumers.

Skeleton sources require parents to precede children. This makes cycles and
missing parents the same evidence-bearing parse failure and lets all runtime
hierarchy evaluation remain a single deterministic forward pass.
