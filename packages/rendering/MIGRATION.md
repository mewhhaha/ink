# Rendering integration

Application composition builds one `RenderWorld` from a scene snapshot, visible
set, canonical material revision, light revision, and animation deformation
outputs. It requests a WebGPU device, selects an explicit quality profile, and
creates `Renderer`, `RenderResourcePool`, and `WebGpuSurface` at the browser
boundary. An unavailable request selects semantic-only operation.

Use `draw_packets` and `instance_batches` once per camera view. The three path
plans accept the same packets. Submit delayed depth-pyramid results through
`GpuOcclusionReadbacks`; camera cuts must pass `{ camera_cut: true }`. On device
loss, discard native resources and temporal history, request a new device, and
call `Renderer.recover`. Genre-specific material interpretation and editor
panels remain in the specialized editor or application.

Every `RenderQualityProfile` selects `upscaling` explicitly. `native` preserves
the surface extent. `fsr1` selects a spatial quality mode and sharpness. `fsr2`
selects a temporal quality mode and sharpness, requires single-sample rendering,
and replaces separate temporal anti-aliasing. Consumers bind the FSR 2 current
and next color/depth history resources as a ping-pong pair, reset them on the
same events as `TemporalHistory`, and apply `fsr2_jitter` to the camera frame.
