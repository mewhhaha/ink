# Package boundary

Ink is a collection of ordinary Blot modules under `lib/`. It depends on Blot's
standard library. A compiler import alias maps `ink/` to this source directory.

Applications construct values and call functions directly. They own their data
model, host protocol, timestep, input, state and presentation. Ink keeps random
state, contact caches and simulation state explicit in its arguments and
results.

Timing consumes caller-supplied seconds. Transforms compose affine bases so
nonuniform scale and rotation retain shear. The physics scene holds a
bounding-volume tree and cached collider geometry; dirty source indices refit
that tree without rebuilding unchanged shapes. Contact ids remain U32. Finite
world-space terrain uses the same scene queries and contact solver as other
colliders.

`mod.ts` exports the local `libraryUrl`, the module names, and `installLibrary`.
The installer copies source files to a caller-selected directory; it also works
when those files are hosted over HTTP. This bridges packaged source modules to a
native compiler that reads the filesystem.

The distribution contains `mod.ts`, `lib/*.blot`, Blot examples, metadata and
docs. The TypeScript entry point uses platform built-ins; it has no compiler
dependency.

Development tools use upstream Blot's `createCompiler` and `instantiateGuest`.
`tools/setup.ts` builds a pinned compiler once, retaining only its binary and
standard library in the ignored `.cache/blot/` directory. CI caches that
payload.

Tests compile handwritten Blot fixtures directly. Physics tests construct
`scene.Source` values and preserve poses, body/controller state and the contact
cache between guest calls. Terrain tests compare the Blot queries with a small,
test-only numerical reference. The distribution test serves the package to an
isolated consumer and runs the examples using only their installed sources.

The dependency direction is simple: applications and tests depend on Ink; Ink
modules depend on each other and Blot's standard library.
