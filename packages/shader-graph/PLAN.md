# @ink/shader-graph plan

Status: implemented; visual-editor integration is intentionally external.

## Purpose

Represent authored shader logic as a small immutable typed DAG and compile it to
the same validated WGSL module contract used by handwritten shaders.

## Ownership

This package owns graph and node identities, socket and value types, immutable
DAG validation, cycle evidence, safe constant folding, dead-node elimination,
parameter schemas, deterministic WGSL generation, external shader-call
dependencies, and versioned serialization. It does not own editor widgets,
material instances, arbitrary script execution, GPU compilation, pipelines,
render passes, or hot-reload transport.

## Contracts

- `ShaderGraph` values with constant, parameter, binary, unary, and declared
  external-call nodes, each exposing typed sockets.
- Exact missing-node, unsupported-operation, value/type mismatch, duplicate
  parameter/output, and cycle-path diagnostics.
- `CompiledShaderGraph` containing a validated `@ink/shaders` module, sorted
  parameter schema, folded node identities, and eliminated node identities.
- Canonical `ink-shader-graph` version 1 JSON serialization and boundary
  parsing.

## Dependencies and integration

The only direct dependency is `@ink/shaders`. Compilation returns its validated
module and dependency contracts, so graph-authored and handwritten WGSL follow
one rendering path. Editors may own graph layout and interaction metadata, but
those concerns are not serialized into the core shader DAG.

## Tasks

- [x] **SGRAPH-001:** Define stable graph, node, parameter, socket, value, edge,
      output, and parameter-schema types.
- [x] **SGRAPH-002:** Implement immutable creation, reference/type validation,
      duplicate checks, and cycle-path diagnostics.
- [x] **SGRAPH-003:** Implement honest scalar/vector constant folding and
      output-reachability dead-node elimination.
- [x] **SGRAPH-004:** Compile outputs deterministically into validated
      `@ink/shaders` functions and explicit module dependencies.
- [x] **SGRAPH-005:** Implement canonical version 1 serialization and defensive
      parsing with unsupported-version evidence.
- [x] **SGRAPH-006:** Test socket types, immutability, stable output, folding,
      elimination, external composition, invalid graphs, and round trips.
- [x] **SGRAPH-007:** Benchmark validation and compilation of a 199-node folded
      graph.

## Operational requirements

Untrusted JSON is parsed once at the boundary. Interior compilation consumes a
validated branded graph and performs no defensive revalidation. Graph ordering,
parameter ordering, dependency ordering, generated function names, WGSL source,
and optimization reports are deterministic. Folding skips division by zero and
operations that would change WGSL semantics.

## Acceptance

Equivalent input ordering produces byte-identical WGSL. Cycles name their exact
node path, socket type mismatches name both nodes and types, and missing
references fail before compilation. Reachable constants fold, unreachable nodes
are reported and omitted, external calls become explicit module dependencies,
and serialized graphs round trip canonically.

## Implementation

Every node has one `value` output and operation-specific named input sockets.
That intentionally narrow shape keeps graph validation and generated functions
readable. Generated identifiers encode punctuation rather than silently merging
names. Compilation emits pure WGSL functions with explicit parameter arguments;
rendering decides how those parameters map to buffers and pipelines.
