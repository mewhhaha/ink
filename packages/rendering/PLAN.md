# @ink/rendering plan

Status: implemented; development retains only its specialized isometric draw
encoding.

## Purpose

Turn immutable views of scene state into WebGPU work through an explicit render
graph and multiple production rendering paths without making GPU objects part of
game state.

## Ownership

This package owns adapter/device lifecycle, GPU resources, render graphs,
extraction, draw packets, batching, instancing, skin and morph upload, shader
compilation, pipeline caches, render targets, transparency, post-processing,
picks, screenshots, and device-loss recovery. Reusable WGSL module composition
belongs to `@ink/shaders`. This package does not own cameras, visibility policy,
asset identity, surface meaning, lights, semantic HTML, or scene state.

## Planned contracts

- `Renderer`, `RenderDevice`, capability and quality profiles, surfaces, frames,
  views, resources, and explicit device-loss states.
- Validated `RenderGraph` passes and resources with declared reads, writes,
  lifetimes, load/store behavior, and cycle diagnostics.
- Immutable extracted `RenderWorld` and ordered `DrawPacket` values using asset,
  surface, mesh, transform, light, and visible-set revisions.
- Three first-release paths: reduced compatibility forward, clustered-forward
  PBR, and deferred PBR. Selection is explicit in a quality profile.
- First-party WGSL modules, reflection metadata, bind-layout policy, pipeline
  cache, depth, transparency, anti-aliasing, tone mapping, bloom, color grading,
  and temporal history.
- Native-resolution, FSR 1 spatial, and FSR 2 temporal quality profiles with
  distinct render/display extents and explicit temporal inputs.

## Dependencies and integration

Direct dependencies: `@ink/math`, `@ink/geometry`, `@ink/assets`, `@ink/scene`,
`@ink/camera`, `@ink/visibility`, `@ink/materials`, `@ink/lighting`,
`@ink/animation`, `@ink/shaders`, and `@ink/observability`. The animation
dependency serves the deformation adapter delivered in the simulation wave and
does not block the renderer device, graph, or static-draw contract milestones.

Materials and lighting provide renderer-independent surface and light records.
Rendering owns their WebGPU layouts, WGSL composition, graph passes, and draw
encoding. UI supplies painted textures through an adapter. The complete WebGPU
implementation in `@ink/development` is the main extraction source.

## Tasks

- [x] **RENDER-001:** Define capability profiles, device/surface lifecycle,
      resource identity, frame ownership, error states, and device-loss rules.
- [x] **RENDER-002:** Implement buffer, texture, sampler, shader, bind-group,
      pipeline, staging, upload, deferred-destruction, and budget management.
- [x] **RENDER-003:** Implement a validated render graph with transient resource
      aliasing, pass ordering, cycle evidence, resize, and frame capture data.
- [x] **RENDER-004:** Implement scene extraction, visible-set consumption,
      stable sorting, instancing, indirect draw preparation, skin/morph upload,
      and incremental revision handling.
- [x] **RENDER-005:** Implement the WebGPU depth-pyramid occlusion adapter,
      delayed revision-tagged result delivery, camera-cut invalidation, and
      visibility diagnostics.
- [x] **RENDER-006:** Deliver compatibility, clustered-forward, and deferred
      paths against the same draw, material, lighting, camera, and output
      contracts.
- [x] **RENDER-007:** Implement opaque and transparent ordering, MSAA where
      compatible, temporal anti-aliasing, tone mapping, bloom, color grading,
      debug views, picking, and screenshots.
- [x] **RENDER-008:** Implement shader diagnostics, pipeline caching, fallback
      resources, resize, device-loss observation, recreation, and semantic-only
      degradation.
- [x] **RENDER-009:** Extract the development renderer without moving
      game-specific isometric surface logic into core.
- [x] **RENDER-010:** Add graph validation, lifetime, draw parity, path parity,
      material revision, BRDF, shadow bias/artifact, occlusion, resize, device
      loss, shader failure, transparency, and golden-image tests.
- [x] **RENDER-011:** Profile CPU extraction, submission, GPU passes, memory,
      material binding and texture pressure, pipeline misses, shadow cache,
      rejected draw work, and GPU time against shared fixtures.
- [x] **RENDER-012:** Adapt composed `@ink/shaders` programs, entry points, and
      typed binding declarations into renderer-owned shader definitions without
      moving GPU compilation or pipeline ownership upstream.
- [x] **RENDER-013:** Define FSR 1 EASU/RCAS and FSR 2 reconstruction, depth,
      reactive-mask, locking, accumulation, sharpening, and history render-graph
      contracts over the shared linear HDR target.

## Operational requirements

- Graph, shader, resource, surface, and device failures carry the adapter, pass,
  resource, and source evidence available. Invalid graphs fail before
  submission.
- Pipeline or asset failure uses typed fallback resources where declared. Device
  loss tears down stale GPU state and leaves runtime and semantic UI active
  during recovery.
- CPU/GPU timings, allocations, uploads, pipeline misses, visible and submitted
  draws, pass failures, capability selection, and device loss emit bounded
  observations.
- Extraction and draw ordering are deterministic for the same snapshots and
  revisions. GPU pixels, timestamps, and asynchronous completion are explicitly
  non-deterministic state.

## Acceptance

All three paths render the same accepted material/light fixture with documented
quality differences and matching object identity, depth, and picking. Render
graph validation prevents read-before-write, incompatible use, and cycles.
Device loss releases stale resources, reports the adapter and operation, and
leaves runtime and semantic UI active while recovery is attempted.

## Implementation

The package separates immutable extraction and path plans from WebGPU-owned
devices, surfaces, resources, shader compilation, and submission. All paths use
the same draw/object identity contract, reversed depth, `rgba16float` HDR, and
sorted alpha; deferred remains explicitly single-sample. The development preview
now consumes the shared renderer WGSL surface module while retaining its
isometric texture-blending rules in the specialized layer. Headless tests cover
graph/path/shader/resource/post-process/device-loss contracts; WebGPU
compilation and timestamp values remain browser capability results rather than
deterministic state.

The FSR 1 path plan renders at its quality mode's reduced extent, then schedules
EASU and RCAS before display-resolution post-processing. The FSR 2 path plan
replaces separate TAA and MSAA; it schedules motion, reactive-mask, luminance,
reconstruction, depth-clip, lock, accumulation, RCAS, and ping-pong history
resources, and exposes deterministic camera jitter. Tone mapping remains the
final conversion from linear `rgba16float` HDR to the configured presentation
surface. A WebGPU consumer must bind the corresponding shader kernels and
history textures when encoding these planned passes.
