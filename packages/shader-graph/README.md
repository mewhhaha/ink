# @ink/shader-graph

An immutable typed shader DAG that compiles deterministically to `@ink/shaders`
WGSL modules. Graphs expose explicit input/output sockets, reject cycles and
type mismatches, fold safe constant expressions, remove unreachable nodes,
retain parameter schemas, and serialize through a versioned format.

Create a graph with `create_shader_graph`, compile it with
`compile_shader_graph`, and compose the resulting module with its declared
`@ink/shaders` dependencies. The package does not own material instances,
rendering pipelines, GPU objects, or editor UI.
