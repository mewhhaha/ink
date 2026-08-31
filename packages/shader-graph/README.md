# @ink/shader-graph

Shader graphs are experimental. The package retains deterministic graph,
serialization, and WGSL compilation fixtures, but no editor game currently uses
an authored graph to change rendered pixels.

The shooter game may promote only the graph and compiler subpaths exercised by
its material-edit browser scenario. All current exports therefore live below
`@ink/shader-graph/experimental/*`.
