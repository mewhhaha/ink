# Pen retained-instance experiment

The patch implements schema-generated stable instance IDs, upserts/removals,
transactional runtime resolution and explicit reset semantics. Ink's matching
adapter and frozen bindings are included in this commit. Applications opt in;
ordinary Ink frames still use immediate draws. The complete protocol contract is
included in the patch as Pen's `docs/retained-instances.md`.

Development and tests used `/var/tmp/ink-pen-retained-fe6348c`. The original
`../pen` working tree was left untouched. The private initial snapshot
`23a8ccec02ec86296fc2708de17858f4a16a4814` captured existing unrelated work.
After concurrent changes, the experiment was rebased onto private snapshot
`d1105c8aa43d3f701263cc69e61610913e29693d`; experiment commit `b660336` contains
only this work. Neither private baseline was pushed. The patch is that final
commit and passes `git apply --check` against the original Pen working tree at
handoff. Concurrent snapshot-cache changes and both sets of regression tests
were preserved in the rebase.

To integrate into that matching checkout, review and apply the patch, regenerate
application bindings with `pen codegen`, then rebuild Pen. For another checkout,
rebase the patch against its current generator/runtime first. Ink's default
adapter now constructs the extended wire frame, so consumers refreshing Ink must
also regenerate their Pen bindings. The wire header grows from 146 to 150 lanes;
there is no backwards-format bridge.

Validation used `just packets` against an isolated copy of the real game,
followed by the codegen, protocol and runtime Cargo suites, targeted release
upload-planner tests, Clippy for all targets in the three changed packages and
format checks for both Pen workspaces. Tests cover malformed packets, every
truncation, full U32 IDs, reset/delta/remove/reorder, preserved old frames and
rejected transactions. Verification was headless; no desktop window opened.

Run `cargo run --release -p pen-runtime --example instances` for the host CPU
comparison. Ink's `deno run -A tools/levers-bench.ts` separately measures guest
encoding. For 4096 instances / 16 frames / 1% dirty, guest encoding fell from
18.756 to 5.156 ms and wire bytes from 6,301,056 to 497,984. Host decode plus
assembly rose from 1.462 to 2.084 ms. Initial packet construction and GPU render
time are excluded from the host comparison. The host still builds a full sorted
draw view; avoiding that traversal is a possible next step.

The original isolated snapshot passed the complete changed-package test suites
and Clippy for all targets. After rebasing onto concurrent work, the new
retained-frame and shared-snapshot tests, protocol/codegen tests and library
Clippy pass. The broader runtime run has 164 passes and two failures in
unchanged `semantic/tests.rs`:
`malformed_observations_are_bounded_and_never_affect_rendered_output` and
`retention_is_bounded_and_missing_history_is_explicit`. All-target Clippy also
reports that file's preexisting `tick as u32` at line 360. The patch does not
change semantic-inspection code. These are limits of the rebased full-suite
validation, rather than failures hidden by the targeted checks.
