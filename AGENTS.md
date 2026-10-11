# Project intent

Ink is one reusable Blot source library for game systems. Applications choose
their own state format, host boundary and presentation.

- `lib/` contains the library. Imports stay within Ink or Blot's standard
  library.
- `shaders/` contains five standalone core WGSL sources. Callers own GPU
  resources and rendering; keep bindings documented in `docs/shaders.md`.
- `mod.ts` only locates and installs source modules for the native compiler.
- `tests/` uses upstream Blot directly, with small handwritten fixtures.
- `examples/` shows library use without schemas or generated code.
- `tools/` prepares the pinned upstream compiler and measures iteration costs.

Keep this boundary small. Calculations and simulation belong in Blot.
Presentation and platform integration belong to callers. Test and compiler
tooling stays outside the published package. Applications own loops and resource
lifetime.

# Working here

- No backward compatibility: change formats and APIs freely, delete old paths.
- Read `docs/architecture.md`; read `docs/blot.md` before writing Blot and add
  any compiler quirk you discover to it.
- Callers own state, random seeds, contact caches and timestep values
  explicitly.
- Contact ids stay U32; keep them out of the solver's F32 tables.
- `scene.update` receives explicit dirty source indices. Reuse unchanged
  geometry and preserve old scene snapshots.
- Terrain colliders are finite, static and authored in world space.
- Affine transforms preserve shear; pose interpolation is a separate operation.
- Preserve deterministic results and meaningful numerical/physics witnesses.
- Measure with `deno task bench`; keep the compiler cached across iterations.
- `deno task check` and `deno task test` before handing work back.
