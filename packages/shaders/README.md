# @ink/shaders

Validated, deterministic WGSL contracts shared by rendering and shader-authoring
tools. The package owns module identity, declared interfaces, dependency
composition, variants, diagnostics, source mapping, replacement decisions, and
reusable source modules. It never creates GPU modules, bind groups, or
pipelines.

Compose modules with `compose_wgsl_modules`, then hand the resulting immutable
`ComposedShaderSource` or `ShaderProgramContract` to a renderer. Compiler
messages can be translated back to their originating module with
`map_shader_diagnostics`.

The reusable module set includes transforms, microfacet BRDF and PBR response,
shadow helpers, fog and sky, terrain seams, and debug/post-processing functions.
`noise_shader_modules` adapts `@ink/noise`'s parity-tested WGSL sources into the
same dependency and symbol contract without making noise depend on shaders.
