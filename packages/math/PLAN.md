# @ink/math plan

Status: implemented.

## Purpose

Provide the numeric vocabulary shared by gameplay, simulation, spatial queries,
and rendering. One convention at this boundary prevents every subsystem from
quietly choosing different axes, units, matrix layouts, or tolerances.

## Ownership

This package owns scalar helpers, vectors, matrices, quaternions, affine
transforms, interpolation, projection construction, and conversions between
deterministic guest values and host floating-point values. It does not own
shapes, collision tests, cameras, physics integration, random number generation,
or GPU resource layout.

The public convention is right-handed and Y-up. Forward is negative Z, matrices
are column-major, and operations use column vectors. A local point is scaled,
then rotated, then translated, so `M = T * R * S`; hierarchies compose as
`world = parent * local`. Angles are radians, distances are metres, durations
are seconds, and WebGPU projections map depth to zero through one.

## Planned contracts

- Immutable `Vec2`, `Vec3`, `Vec4`, `Quat`, `Mat3`, `Mat4`, and `Transform`
  values with finite inputs.
- Explicit point, direction, normal, and homogeneous transform operations.
- Perspective, orthographic, reversed-depth, and jittered projection builders.
- Stable interpolation, comparison, clamping, wrapping, and angle operations.
- Boundary codecs for fixed-point guest values; fixed-point policy remains in
  the guest adapter rather than infecting host math.

## Dependencies and integration

Direct dependencies: none.

Geometry, camera, rendering, animation, physics, audio, and world consume these
values. Existing matrix and transform code in `@ink/development/webgpu.ts` and
fixed-point conversion conventions in `@ink/blot` are extraction inputs, not
APIs to preserve.

## Tasks

- [x] **MATH-001:** Specify axes, handedness, units, storage, multiplication
      order, finite-value policy, epsilon policy, and equality semantics.
- [x] **MATH-002:** Implement scalar, vector, quaternion, matrix, and transform
      operations as pure functions without hidden allocation or mutation.
- [x] **MATH-003:** Implement view, projection, inversion, decomposition, normal
      transformation, and screen/depth conversion with explicit failure results
      for singular matrices.
- [x] **MATH-004:** Add guest fixed-point codecs that reject overflow and
      non-finite host values with the offending value in the error.
- [x] **MATH-005:** Add property and fixture tests for identities, inverses,
      composition, interpolation, coordinate conventions, and WebGPU clip space.
- [x] **MATH-006:** Benchmark bulk transform operations and record a baseline
      before selecting any specialized storage or SIMD representation.

## Operational requirements

- Parsed constructors return evidence-bearing failures for non-finite,
  overflowed, or singular inputs; violated internal invariants fail loudly.
- The package has no degradable platform capability and emits no observations.
- All public operations are pure and deterministic for the same inputs and
  build.

## Acceptance

Known points project to expected viewport and depth coordinates for perspective,
orthographic, reversed-depth, and jittered views. Transform composition and
decomposition round-trip within documented tolerances. Invalid and singular
inputs fail at the boundary instead of producing NaN-filled interior values.
