# Vendored Blot compiler resources

This directory contains the clean Blot compiler source and the generated parser/runtime artifacts needed to compile the Doom example's `.blot` program into WebAssembly.

Included:

- `src/`: compiler and CLI source
- `generated/`: checked-in parser and Rust-middle compiler artifacts
- `deno.json` and `deno.lock`: compiler import map and dependency lockfile
- `grammar.baba`, `baba.json`, and `mod.ts`: compiler metadata and exports
- `scripts/`: compiler maintenance scripts used by the upstream checkout
- `REVISION`: base checkout revision and snapshot caveat

The Rust and WebAssembly build caches from the upstream checkout are intentionally excluded. External JSR dependencies remain declared in `deno.json`; they are not vendored here. The generated Doom menu WASM and manifest are checked in under `generated/` so the app can run from a clean checkout after dependencies are installed.