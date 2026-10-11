# Package boundary

Ink is a Blot source library. Its 30 modules live under `lib/`, imported through
a caller's `ink/` alias. They depend only on each other and Blot's standard
library. Applications own their state, host protocol, timestep, rendering, UI,
input and audio backend. [API contracts](blot.md) define numerical and packing
conventions.

`mod.ts` is the minimal source locator and installer: `libraryUrl`, `modules`
and `installLibrary`. Local consumers map their compiler alias to `libraryUrl`;
HTTP consumers install the sources into a directory before native compilation.
It contains no game runtime or platform integration.

The distribution ships Blot modules, five standalone core WGSL shaders, Blot
examples, documentation and the source installer. The
[shader contracts](shaders.md) define bindings and vertex layouts; callers own
the renderer and GPU resources. Tests pack the sources with Deno, check their
boundary and compile the installed Blot modules from isolated HTTP and Node
consumers.

Tests and tools remain outside the published package. `tools/setup.ts` caches
the pinned upstream Blot compiler and standard library in `.cache/blot/`. Tests
compile handwritten fixtures directly with upstream `createCompiler` and
`instantiateGuest`. Benchmarks measure every module, scaling, replay and memory
growth while retaining numerical witnesses.
