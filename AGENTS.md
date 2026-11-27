# Project intent

Ink is one reusable Squid source library for game systems. Applications choose
their own state format, host boundary and presentation.

- `lib/` contains reusable mechanisms, including ECS, scheduling, persistence,
  input, UI and declarative presentation. Core imports stay within Ink/std.
- `lib/pen/` is an optional Squid adapter and may import generated `pen/` wire
  bindings. Pen's generator and runtime never depend on Ink or a game.
- `shaders/` contains five standalone core WGSL sources. Callers own GPU
  resources and rendering; keep bindings documented in `docs/shaders.md`.
- Consumers map an import alias to `lib/`; the source package needs no
  installer.
- `tests/` contains small handwritten Squid fixtures run by Pen.
- `tools/native/` holds Rust numerical references, GPU checks and developer
  tools.
- `examples/` shows library use without schemas or generated code.
- `pen.json` names the native compiler and standard library; tools use Pen's
  compiler plugin and guest host.

Keep this boundary small. Calculations and simulation belong in Squid.
Applications supply assets, fonts, input mappings, defaults and policy. Platform
resources and playback belong to hosts. Test and compiler tooling stays outside
the published package. Applications own loops and resource lifetime.

# Working here

- This is a greenfield project. Breaking changes are welcome. Remove superseded
  code, APIs and compatibility scaffolding instead of preserving legacy
  behavior.
- The owner requests continuous checkpoints to `main`: commit and push coherent,
  checked batches as work progresses. Verify each push and report failures.
- Use `func`, explicit `return`, curried `->`, `$Constructor`, `true` / `false`,
  `and` / `or` and `#[...]` arrays. Declare owners separately; access records
  alias pools and do not preserve snapshots. Keep borrows invocation-local and
  copy retained state and worker packets explicitly. Preserve callback effects.
- Preserve ABI 8 and session protocol 2 with explicit checkpoint/restore.
  Language tasks are retired; host data queues and copied-buffer workers remain.
- Use the existing sibling checkouts and matching locally built Squid/Pen tools.
  Preserve unrelated work and include only the intended batch in each
  checkpoint.
- No backward compatibility: change formats and APIs freely, delete old paths.
- Read `docs/architecture.md`; read `docs/squid.md` before writing Squid and add
  any compiler quirk you discover to it.
- Callers own state, random seeds, contact caches and timestep values
  explicitly.
- Contact ids stay U32; keep them out of the solver's F32 tables.
- `scene.update` receives explicit dirty source indices and mutates live caches.
  Reuse unchanged geometry. Retain an old scene only through an explicit copy
  with a nested-geometry policy; descriptors and borrowed views are not
  snapshots.
- Terrain colliders are finite, static and authored in world space.
- Affine transforms preserve shear; pose interpolation is a separate operation.
- Preserve deterministic results and meaningful numerical/physics witnesses.
- Measure with `pen tool ink -- bench`; retain numerical witnesses and source
  hashes.
- Run `pen tool ink -- fmt --check`,
  `pen tool ink -- generate tools/generate.json` and `pen test-squid` before
  handing work back. GPU tests run headlessly.
- Generate codecs/bindings from their inputs; do not hand-edit generated
  outputs or remove assertions to make checks pass.
