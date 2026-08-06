# Materials consumer migration

`@ink/materials` now owns the renderer-independent definition, import, instance,
fallback, feature-key, and revision contracts. Existing consumers remain
unchanged so this package can land independently of rendering and development
work.

The consumer cutover should be made in these narrow steps:

1. Extend the glTF asset adapter to preserve each material's workflow factors,
   texture indices, transforms, alpha mode, and sidedness. Convert that neutral
   payload with `import_metallic_roughness` or `import_specular_glossiness`; do
   not add rendering fields to the asset package.
2. Translate texture indices into validated `TextureBinding` values after the
   corresponding image assets have stable `AssetId<"texture">` identities.
   Missing images remain bindings and resolve through their typed fallbacks.
3. Replace the current rendering color, emissive, blend, path, and surface-mode
   fields with `CanonicalMaterialRecord`. Rendering owns the GPU record layout
   and uses `feature_key`, definition revision, and instance revision to choose
   pipeline and resource invalidation.
4. On asset hot replacement, build every candidate definition first and submit
   the complete batch to `MaterialLibrary.replace`. A rejected batch retains all
   definitions and instance revisions.
5. Adapt world and visual-effect material choices to stable instance identities
   and bounded overrides. Keep terrain rules and effect-specific behavior in
   those packages rather than adding them to core materials.
6. Use `evaluate_reference_brdf` only as a deterministic conformance fixture.
   Lighting and rendering must implement and test the production physical
   response together.

No renderer pipeline, WGSL source, texture loader, editor panel, or game rule
belongs in this package during the cutover.
