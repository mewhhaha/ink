# Lighting consumer migration

`@ink/lighting` now owns renderer-independent light, cluster, logical shadow,
probe, environment, exposure, atmosphere, and quality plans. Existing rendering
and development consumers remain unchanged so the package can land without a
cross-package partial migration.

Consumer cutover should proceed in these narrow steps:

1. Convert the development directional-toon fixture into a validated
   `LightDefinition` with a stable `LightId`. Scene-attached lights keep their
   `SceneNodeId`; world and visual effects remain responsible for authoring and
   revising them.
2. Build one `LightingPlan` per stable `CameraView`, passing the current
   visibility revision, caster revision, prior shadow cache, quality pressure,
   exposure inputs, probes, and prefetched environments.
3. Feed that exact plan to compatibility, clustered-forward, and deferred
   rendering. Rendering maps canonical records to WGSL and GPU layouts; it must
   not reinterpret units, cluster overflow, feature priority, or exposure.
4. Translate `ShadowView` projection descriptors and logical atlas tiles into
   render-graph passes and physical textures. Return the plan's cache on the
   next frame and render every entry whose invalidation action is `render`.
5. Decode environment assets through `@ink/assets`, import pixels with
   `import_environment_image`, and build the reference prefilter record. A GPU
   prefilter adapter may replace the reference processor only if it preserves
   the same roughness, irradiance, revision, and split-sum semantics.
6. Adapt baked irradiance, reflection probes, and light maps from world data.
   Baked-light authoring UI, weather evolution, texture residency, and render
   passes stay in their owning layers.
7. Emit renderer timings and GPU allocation observations alongside the bounded
   CPU observations already emitted by this package.

No GPU object, WGSL module, visibility policy, weather simulation, or editor
panel belongs in `@ink/lighting` during this migration.
