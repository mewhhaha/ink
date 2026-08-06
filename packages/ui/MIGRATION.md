# Semantic UI consumer migration

The package provides `migrate_legacy_semantics` for the current engine DTO and
keeps the returned legacy action table separate from the game-neutral semantic
tree. Consumer cutover is intentionally deferred because development, camera,
rendering, and game applications are owned by parallel work.

The later integration change should:

1. Convert each complete legacy region update with `migrate_legacy_semantics`,
   validate it through `UiSnapshotStore`, and retain the previous snapshot on a
   rejection.
2. Replace `InkGameSurfaceElement.update_semantics` with `BrowserUiAdapter` and
   translate its normalized target identity through the migration action table
   to the existing game action.
3. Feed normalized `ui.*` input actions into `UiController`, using its focus as
   the authoritative identity across render frames and compatible reloads.
4. Supply `layout_ui` with the camera-owned `SceneUiProjector`; viewport-only
   and headless modes require no camera.
5. Implement `UiTextureCopyBoundary` with the renderer's existing browser
   element copy operation. Keep overlay HTML mounted and switch to it when the
   copy operation or WebGPU is unavailable.
6. Move Blot flex output to retained container nodes once the guest UI binding
   targets this package, then remove duplicate legacy focus and DOM patching.

No editor panels or game rules move into `@ink/ui` during this cutover.
