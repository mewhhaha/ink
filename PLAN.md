# Ink engine package roadmap

Status: implemented and verified through package, cross-package, genre, browser,
and headless fixtures.

Ink is moving toward small, game-neutral packages that specialized editors and
games can compose without adopting a universal editor or an entity model. This
roadmap records the resulting ownership and acceptance boundaries.

## Architecture rules

- Dependencies point from specialized capabilities toward general foundations.
- A package owns its public contract and its first-party default implementation.
  Platform-specific implementations use explicit subpath exports rather than
  separate backend packages.
- The ECS is optional. Primary rendering, physics, audio, and other contracts do
  not expose ECS identities; dedicated adapters may translate ECS views.
- A downstream package owns an adapter when the dependency graph stays one-way.
  Adapters that would introduce a reverse dependency live in the specialized
  editor or application that composes both packages. Adapter subpaths declare
  every package whose types they import.
- Host effects remain explicit at the Wasm boundary. Clocks, input, randomness,
  storage, network access, and platform devices are never ambient dependencies.
- Meaningful game state and actions remain available through the accessible
  semantic surface and headless host when graphics or audio are unavailable.
- Inputs, clocks, randomness, snapshots, and scheduling reproduce within one
  engine and game build. Rendering is not deterministic state.
- Runtime algorithms are Ink-owned. Browser facilities such as WebGPU, Web
  Audio, Web Workers, IndexedDB, and built-in media decoders are platform
  boundaries, not replaceable engine implementations.
- Playable examples use Blot for state, rules, actions, and outcomes. TypeScript
  in an example may compile, host, render, or test the guest, but it does not
  provide a second gameplay implementation.

World coordinates are right-handed and Y-up. Cameras look along negative Z,
WebGPU depth is zero to one, and public measurements use metres, radians, and
seconds. Guest languages may use another numeric representation, but their
adapters convert once at the package boundary.

## Package map

| Layer                 | Packages                                                                                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundations           | [math](packages/math/PLAN.md), [geometry](packages/geometry/PLAN.md), [observability](packages/observability/PLAN.md), [assets](packages/assets/PLAN.md), [runtime](packages/runtime/PLAN.md)                                                                                       |
| State and interaction | [ecs](packages/ecs/PLAN.md), [scene](packages/scene/PLAN.md), [input](packages/input/PLAN.md), [camera](packages/camera/PLAN.md), [ui](packages/ui/PLAN.md), [localization](packages/localization/PLAN.md), [text](packages/text/PLAN.md)                                           |
| World and graphics    | [world](packages/world/PLAN.md), [visibility](packages/visibility/PLAN.md), [rendering](packages/rendering/PLAN.md), [materials](packages/materials/PLAN.md), [lighting](packages/lighting/PLAN.md)                                                                                 |
| Simulation and media  | [animation](packages/animation/PLAN.md), [timeline](packages/timeline/PLAN.md), [physics](packages/physics/PLAN.md), [navigation](packages/navigation/PLAN.md), [audio](packages/audio/PLAN.md), [visual effects](packages/visual-effects/PLAN.md)                                  |
| Authoring foundations | [authoring](packages/authoring/PLAN.md), [noise](packages/noise/PLAN.md), [procedural](packages/procedural/PLAN.md), [shaders](packages/shaders/PLAN.md), [shader graph](packages/shader-graph/PLAN.md), [editor UI](packages/editor-ui/PLAN.md)                                    |
| Specialized editors   | [platformer](editors/platformer/PLAN.md), [shooter](editors/shooter/PLAN.md), [role-playing](editors/roleplaying/PLAN.md), [narrative](editors/narrative/PLAN.md), [strategy](editors/strategy/PLAN.md), [adventure](editors/adventure/PLAN.md), [vehicle](editors/vehicle/PLAN.md) |
| Connected runtime     | [networking](packages/networking/PLAN.md)                                                                                                                                                                                                                                           |

Behavior trees, quests, dialogue, inventory, and other genre rules belong in
specialized editors or games. Terrain belongs to world, occlusion belongs to
visibility, shadows belong to lighting, and post-processing belongs to
rendering.

## Delivery order

- [x] **FOUNDATION-001:** Establish math, geometry, observability, asset
      identity, and runtime contracts without depending on rendering or a game
      language.
- [x] **STATE-001:** Implement optional ECS, scene snapshots, normalized input,
      cameras, and accessible UI on those foundations.
- [x] **GRAPHICS-001:** Accept renderer-independent material and lighting
      contracts plus the rendering device and graph contracts, then deliver
      compatibility, clustered-forward, and deferred integrations using the same
      visibility, material, and lighting inputs.
- [x] **SIMULATION-001:** Add animation, first-party collision and rigid-body
      physics, navigation, audio, and visual effects through explicit scene
      adapters.
- [x] **NETWORK-001:** Add authoritative sessions, replication, prediction,
      reconciliation, and optional rollback over deterministic runtime frames.
- [x] **TIMELINE-001:** Add validated cross-system sequence documents, pure
      playhead evaluation, referenced clip regions, and deterministic event
      traversal.
- [x] **LOCALIZATION-001:** Add locale fallback, structured catalogs, plural and
      select formatting, localized assets, measured text layout, browser text
      measurement, and world-text scene attachments.
- [x] **SCENE-INSTANCE-001:** Make serialized scenes the reusable composition
      primitive with nested instancing, source ownership, and local overrides.
- [x] **INTEGRATION-001:** Validate the complete engine through headless,
      accessible, rendering, streamed-world, character, and multiplayer slices.
- [x] **PROCEDURAL-001:** Add deterministic CPU and WGSL noise, versioned world
      recipes, terrain and biome synthesis, bounded scattering, signed-distance
      composition, and first-party surface extraction.
- [x] **SHADER-001:** Add validated WGSL modules, dependency composition,
      variants, diagnostics, hot reload, reusable shader functions, and typed
      graph compilation into renderer-consumable contracts.
- [x] **EDITOR-001:** Add source-owned, accessible editor controls and chrome on
      `@comp0/react`, while leaving panels and workspace composition to focused
      editors.
- [x] **AUTHORING-001:** Exercise the editor primitives in a component gallery
      and compose noise, shader graphs, editable WGSL, and optional WebGPU
      diagnostics in a specialized shader lab.
- [x] **FINETUNE-001:** Add narrow authoring history, discovery, and diagnostics
      plus platformer, shooter, role-playing, narrative, strategy, adventure,
      and vehicle editors with opinionated subgenre presets and valid starters.
- [x] **PLATFORMER-STUDIO-001:** Compose platformer-specific tools, level
      structure, validation, presets, history, and document preview into a
      creator surface whose playtest remains the compiled Blot application.
- [x] **BLOT-EXAMPLES-001:** Express every playable genre example as a compiled
      Blot guest with host-only TypeScript, a hot-reloading Vite browser host,
      and observable headless acceptance scenarios.

A package begins implementation only after the upstream contract milestones it
uses are accepted; downstream integration does not block acceptance of an
upstream core contract. A delivery is complete when platform-independent
conformance and degradation fixtures pass headlessly, browser-only backends pass
browser fixtures, and shared contracts agree wherever both hosts provide the
capability.

## Existing-package migration

`@ink/engine` was replaced by `@ink/runtime`; game-neutral contracts moved to
their owning packages and Blot-specific preview vocabulary moved to the Blot
adapter before the old package was deleted. No compatibility facade remains.

`@ink/development` retains development transport, editor composition, and Vite
integration. Its preview consumes shared projection, scene, asset build,
observability, renderer-WGSL, and semantic contracts while the specialized
isometric draw rules remain local.

`@ink/blot` remains the Blot language adapter and reusable guest library. Its
game-neutral host contracts use the new packages; its fixed-point preview ABI
and session vocabulary remain local to the adapter.

## Cross-package acceptance slices

- The same scene, camera, visible set, PBR materials, specular response, lights,
  and shadows render through compatibility, clustered-forward, and deferred
  paths.
- Frustum, LOD, and occlusion decisions are conservative. Missing, stale, or
  uncertain occlusion information keeps an object visible.
- A streamed terrain crosses scene, visibility, rendering, collision, and
  navigation boundaries without duplicating authoritative world state.
- Normalized input drives a character through physics and animation while the
  camera, audio listener, and accessible UI observe the same frame.
- Save and replay reproduce a run within the same engine and game build.
- A simulated authoritative session tolerates latency, loss, duplication, and
  reordering while prediction converges on server state.
- Loss of WebGPU or audio is observable and leaves headless gameplay and the
  semantic interface usable.
- The same noise seed and periodic coordinates reproduce CPU fixtures, baked
  textures, procedural terrain input, and equivalent reusable WGSL contracts.
- Shader module and graph ordering is deterministic; malformed dependencies,
  cycles, socket types, variants, bindings, and device diagnostics retain source
  evidence.
- Reusable editor controls preserve native semantics, keyboard navigation, focus
  visibility, reduced-motion preferences, and server-renderable fallback states
  independently of a specialized editor.
- Every specialized editor can create a valid starter without exposing unrelated
  engine capabilities, and its diagnostics identify broken authored references
  without executing game rules.
- Genre examples expose discoverable actions and outcomes from compiled Blot
  guests in both Vite browser hosts and headless sessions, so their meaningful
  paths can be played accessibly and tested without inferring state from pixels.
