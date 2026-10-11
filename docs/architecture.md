# Package boundary

Ink contains ordinary Blot modules under `lib/`, imported through a caller's
`ink/` alias. Modules depend only on each other and Blot's standard library.
Applications choose their state, host protocol, timestep and presentation;
[API contracts](blot.md) define numerical and packing conventions.

`mod.ts` exports `libraryUrl`, `modules` and `installLibrary`. Local consumers
map their compiler alias to `libraryUrl`; HTTP consumers install the sources
into a caller-selected directory before native compilation.

`adapters/` provides optional WebGPU, DOM controls, input, accessibility
preferences and WebAudio entry points. Adapters use platform APIs; importing
`mod.ts` does not load them. Callers own devices, encoders, textures, temporal
history, audio contexts, scheduling, markup and listener disposal. Only examples
own loops.

The distribution ships the library, adapters, WGSL, examples and documentation.
Tests pack it with Deno and run isolated HTTP and Node consumers against the
resulting archive, including every exported entry and shader. Tooling and tests
stay outside the package.

`tools/setup.ts` caches a pinned upstream Blot compiler and standard library in
`.cache/blot/`. Tests compile handwritten fixtures directly with upstream
`createCompiler` and `instantiateGuest`. Benchmarks measure iteration costs and
retain numerical witnesses.

The browser harness and dev server share source serving and dependency-aware
bundling. Chromium's HTTP/CDP startup and requests have deadlines; failures
retain stderr, page logs and screenshots when available. `INK_CHROME` selects
another browser. Software GPU QA uses Vulkan SwiftShader for rendering and
compositing. Browser tests inspect pixels, native keys, accessibility trees,
offline audio and repeated disposal. Screen-reader speech and hardware
performance need manual measurements.
