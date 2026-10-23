# Pen retained-instance experiment

The patch implements schema-generated stable instance IDs, upserts/removals,
transactional runtime resolution and explicit reset semantics. Ink's matching
adapter and frozen bindings are included. Applications opt in; ordinary Ink
frames still use immediate draws. The protocol contract is included in the patch
as Pen's `docs/retained-instances.md`.

Development and tests used `/var/tmp/ink-pen-retained-fe6348c`. The original
`../pen` source checkout was left untouched. The patch applies to private
snapshot `d1105c8aa43d3f701263cc69e61610913e29693d`, which captured the
concurrent Pen work before this experiment. It includes experiment commit
`b660336` and the subsequent CPU assembly and GPU upload changes. Neither
private baseline was pushed. `git apply --check` passes against an isolated copy
of the recorded base; a newer Pen checkout may require rebasing.

To integrate, review and apply the patch, regenerate application bindings with
`pen codegen`, then rebuild Pen. Ink's default adapter constructs the extended
wire frame, so consumers refreshing Ink must also regenerate their Pen bindings.
The wire header grows from 146 to 150 lanes; there is no backwards-format
bridge. The subsequent upload changes add host-only metadata and leave those
wire bytes unchanged. Use an isolated Cargo target directory: a shared cache
reused the original checkout's older decoder until its protocol artifacts were
rebuilt.

The host caches sorted draw order and patches changed slots. It still copies a
complete draw view, while avoiding a full map traversal and sort on ordinary
deltas. Accepted revisions carry dirty draw indices into the renderer. A
connected revision chain permits skipping unchanged instance values; skipped
frames, reordered draws, changed culling/LOD placement or default parameters use
bitwise comparison. The CPU instance buffer also serves as the GPU shadow.
Rejected candidates and earlier snapshots remain independent. GPU buffer
replacement forces a full upload.

Validation used `just packets` against an isolated real game: export and all 120
packets pass. Codegen passes 10 tests; protocol passes 16 tests with one
ignored. Both upload-planner tests and both headless culling/LOD tests pass. The
GPU tests verify pixels after moving/reordering draws and replacing the buffer;
the planner checks signed zero, duplicate placements, skipped frames,
parameters, fragmentation and complete simulated GPU contents. One changed
instance in a 100-instance fixture uploads 80 bytes; an unchanged connected
frame uploads zero. Both Pen workspaces pass formatting checks. No desktop
window was opened.

Run `cargo run --release -p pen-runtime --example instances` for the host CPU
comparison. With 4096 instances, 16 frames and 1% dirty per frame, the current
paired run measured 1.745 ms retained versus 2.904 ms immediate. Wire bytes are
497,984 versus 6,301,056. The benchmark includes packet decode and CPU assembly,
with 20 warmup pairs and 20 measured alternating pairs and equal final draws.
Initial packet construction, guest encoding and GPU rendering are excluded.
These are CPU and upload-volume results, not a GPU frame-time claim.

Broader validation is not fully green in this private Pen snapshot. Runtime has
165 passes and the same two failures recorded before this follow-up in unchanged
`semantic/tests.rs`:
`malformed_observations_are_bounded_and_never_affect_rendered_output` and
`retention_is_bounded_and_missing_history_is_explicit`. Renderer library tests
have 54 passes, two ignored and one failure in unchanged
`shadows_follow_casting_materials_and_reload_without_frame_thread_compilation`:
its expected pipeline mask omits the inset variant described by its comment.
All-target Clippy reports the unchanged `tick as u32` in semantic tests and five
unchecked sprite-index casts in `renderer/frame.rs` and `sprites.rs`. Those
files are outside this patch. The new retained-state tests pass, including the
assertion that only accepted frames advance revision identity.
