# Native checks and tools

Blot test suites in `tests/` use first-class `@[test.suite]` + `test "..." :` /
`test expect_trap "..." :` declarations with `std/test` assertions (plus
`tests/support/bits.blot` for bit-exact float comparisons). You can run them
standalone via `blot test` (configured by `blot.json`) or together with Ink's
Rust reference and headless GPU suite via `pen test-blot` (configured by
`pen.json`):

- `blot test` runs every Blot test module and `tests/rejected/` compile-rejection
  fixture declared in `blot.json` (backed by Ink's `blot-workspace.yaml`). Pass
  `--filter TEXT` or explicit `.blot` paths to narrow the run; pass
  `--std-root ../blot2/std` if a sibling `../blot2` checkout's `std/flat` needs
  `--std-root` intrinsic privilege rather than a package alias.
- `pen test-blot` runs the configured Blot modules, then the Rust suite declared
  by `tests.rust` in `pen.json`. `--filter TEXT` selects names in both suites;
  explicit `.blot` operands select only Blot modules. Pen shares compiler
  sessions per worker. Rust caches compiled modules and creates a fresh guest
  for each fixture. Every guest call has a deadline; `--deadline SECONDS` sets
  it for both suites. GPU tests use offscreen textures, never a window.

The Rust suite lives in `tools/native`. It keeps independent arithmetic/search/
physics references, exact word and floating-point boundaries, randomized seeds,
replay/memory checks, shader pixels, generated-code equivalence, source
packaging and runnable documentation examples. `workloads.json` retains
benchmark sizes and coverage; a test runs every workload's smallest witness. The
benchmark command runs every size and its replay/memory checks.

`pen tool ink -- fmt --check` checks Rust formatting.
`blot doc ink --check-links --test` verifies every intra-doc symbol link across `lib/` and compiles/runs all ```` ```blot ```` doctests to ABI 8 Wasm (`blot doc ink --html --out DIR` exports a static HTML site with runnable browser examples).
`pen tool ink -- generate tools/generate.json` checks generated fixtures without
changing them; append `--write` to regenerate. Generation config has a `jobs`
array with these alternatives:

- `codec`: `source`, `schema`, `output`; optional `published` input baseline,
  `manifest` output, or `generic: true` to disable scalar specialization.
- `behavior`: `source`, `graph`, `output`; optional `selector: true`.
- `dataflow`: `graph`, `output`; optional dependency/wave `manifest` output.

All jobs accept `prefix`, `suffix` and an `entry` that instantiates the emitted
module. Paths are relative to the selected checkout. For another application:
`pen tool ink -- generate /path/to/jobs.json --project /path/to/game`. The
generator checks models and output through that project's Pen compiler settings,
and validates all jobs before writing. The codec shape scanner is intentionally
narrower than Blot; unsupported types require handwritten codecs.

`pen tool ink -- pack DIR` writes a fresh source directory and `ink.json`
hashes. It refuses an existing destination. Consumers only need an alias to its
`lib/`. Tests use an isolated package under a different alias and directory with
spaces.

`pen tool ink -- site DIR [--overwrite] [--no-docs]` builds Ink's static GitHub
Pages examples gallery: it compiles the interactive asset-free Pen demos via
`pen build --web` (sharing one deduplicated `pen/` WebGPU runtime across all
demos), compiles every standalone `examples/*.blot` fixture to ABI 8 Wasm for
in-browser execution, and runs `blot doc ink --html` into `DIR/docs`.
`.github/workflows/pages.yml` builds and publishes this site to GitHub Pages.

Pen owns compiler caching and deadlines. Runtime correctness assertions live in
Blot (`tests/`) and independent Rust references (`tools/native/src/`); shader
checks execute WGSL headlessly. Rejected fixtures in `tests/rejected/` verify
compile-time contracts (pure derived callbacks, Unit-returning fixed updates,
distinct handle kinds, and non-escaping scene query storage).
