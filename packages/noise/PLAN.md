# @ink/noise plan

Status: implemented and verified.

## Purpose

Provide deterministic, reusable procedural scalar and vector fields for game
assets, specialized editors, runtime effects, and shaders without owning any
consumer's world or rendering state.

## Ownership

This package owns stable noise seeds and periods, integer hashing, lattice
interpolation, gradient selection, cellular feature placement, fractal
composition, domain transforms, batch sampling, CPU baking, WGSL source, and
CPU/WGSL parity fixtures. Consumers own how sampled values become terrain,
textures, materials, animation, effects, or gameplay decisions.

## Dependencies and integration

The only direct dependency is `@ink/math` for the repository's canonical vector
types. CPU sampling is pure. GPU consumers compile the exported WGSL source in
their own rendering pipeline and are responsible for device capability and
resource lifecycle.

## Tasks

- [x] **NOISE-001:** Define branded seeds, named 1D/2D/3D inputs, explicit
      periodic domains, and boundary validation.
- [x] **NOISE-002:** Implement stable seeded hashing and periodic value noise in
      1D, 2D, and 3D.
- [x] **NOISE-003:** Implement periodic gradient noise with fixed, portable
      gradient tables in 1D, 2D, and 3D.
- [x] **NOISE-004:** Implement cellular/Worley nearest and second-nearest
      sampling with Euclidean, Manhattan, and Chebyshev metrics.
- [x] **NOISE-005:** Implement normalized fBm, turbulence, ridged noise, domain
      warp, and dimensionally valid curl fields.
- [x] **NOISE-006:** Implement batch sampling and row-major, interleaved 2D
      texture and 3D volume baking.
- [x] **NOISE-007:** Publish composable WGSL modules and literal parity fixtures
      with an honest headless CPU verifier.
- [x] **NOISE-008:** Test determinism, negative coordinates, exact tiling,
      dimensions, validation, baking layout, curl divergence, and WGSL contract
      stability.
- [x] **NOISE-009:** Benchmark hashing, primitive fields, cellular search,
      fractal composition, domain warp, baking, and WGSL assembly.

## Acceptance

- The same seed and input produce the same CPU result across calls.
- Periodic fields repeat at their declared period, including composites and
  negative coordinates.
- Hashes and lattice choices match WGSL exactly; floating-point field values use
  documented fixture tolerances.
- Invalid seeds, coordinates, periods, fractal settings, bake dimensions,
  channels, and non-finite callback results fail with the offending value.
- Batch and bake layouts are documented and covered by observable tests.
