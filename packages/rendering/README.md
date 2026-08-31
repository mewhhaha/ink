# @ink/rendering

`renderer.ts` is the stable presentation boundary. One renderer owns the WebGPU
adapter, device, canvas surface, resources, pipelines, submission, picking, and
loss recovery for both raster and path-traced techniques. A lost device releases
its resources before the renderer requests a new non-fallback adapter and
rebuilds the device-owned state.

Raster frames run canonical frustum, distance, projected-size, layer, and LOD
selection before uploading color-pass instances. Active geometry remains in the
shadow pass and path-tracing scene, so a camera rejection cannot remove a shadow
caster or an object reached by reflected rays.

The stable raster technique is clustered-forward. Compatibility and deferred
path planning remain experimental until the renderer executes and proves them.
Imported mesh buffers use a deterministic ID-and-byte key, so reconstructed
scene arrays do not cause uploads while vertex or index edits do.

Raster anti-aliasing is explicit. `none` samples the resolved HDR image, `fxaa`
uses the composed edge filter, and `taa` blends clamped temporal history with a
jittered camera. TAA history resets after camera, scene, viewport, technique, or
device-lifecycle changes. That history is presentation state and never enters a
runtime snapshot or replay checksum.

Path-tracing history retains its packed CPU scene while the scene revision and
resource-upload plan are unchanged. Camera motion and texture-only changes clear
sample accumulation without rebuilding that packed scene.

The modules under `@ink/rendering/experimental/*` remain outside the stable
surface. They do not provide a second renderer or a raw shader path.
