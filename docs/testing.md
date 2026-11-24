# Native checks and tools

Run `pen test-blot` in Ink. Pen runs the configured Blot modules, then the Rust
suite declared by `tests.rust` in `pen.json`. `--filter TEXT` selects names in
both suites; explicit `.blot` operands select only Blot modules. Pen shares
compiler sessions per worker. Rust caches compiled modules and creates a fresh
guest for each fixture. Every guest call has a deadline; `--deadline SECONDS`
sets it for both suites. GPU tests use offscreen textures, never a window.

The Rust suite lives in `tools/native`. It keeps independent arithmetic/search/
physics references, exact word and floating-point boundaries, randomized seeds,
replay/memory checks, shader pixels, generated-code equivalence, source
packaging and runnable documentation examples. `workloads.json` retains
benchmark sizes and coverage; a test runs every workload's smallest witness. The
benchmark command runs every size and its replay/memory checks.

`pen tool ink -- fmt --check` checks Rust formatting.
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

Pen owns compiler caching and deadlines. Runtime correctness assertions live in
Blot (`tests/`) and independent Rust references (`tools/native/src/`); shader
checks execute WGSL headlessly. Rejected fixtures in `tests/rejected/` verify
compile-time contracts (pure derived callbacks, Unit-returning fixed updates,
distinct handle kinds, and non-escaping scene query storage).
