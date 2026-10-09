# Continue here

Where the work stopped on 2026-10-09 and what to pick up next. `PLAN.md` has the
twenty hills with a dated note under each one; this file is the short version.

## State

Nineteen of the twenty hills have an implementation with a verification note.
**Hill 3 (prefabs and nested scenes) has not been started.** Several gates are
implemented but not fully met; they are listed below.

This session landed hills 1, 2, 10, 11, 12 and 13 on top of Codex's work:

| Hill              | What landed                                                                                                                                     | Gate                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1 World transport | Step stays stateless (a guest-resident world was measured and rejected); lazy packed entities, in-place encode, byte-budgeted timeline and undo | 20k entities at 60 Hz with a fifth moving; all moving is inside 16.7 ms only on a quiet machine        |
| 2 Physics         | `ink/physics` (shapes, SAT, sequential impulse, sleeping, character controller, queries); every example migrated                                | 50-box stack byte-identical, towers stand awake; 200 bodies 14 ms median (loaded machine), target 6 ms |
| 10 Large worlds   | `terrain`/`scatter` components, CDLOD terrain, GPU-culled scatter, streaming, `@ink/terrain` tools, `ink/terrain`, `examples/terrain`           | 4.2 km² with 100k instances: fly 11.0 ms, play 8.4 ms, strokes at vsync (RTX 4080 SUPER)               |
| 11 2D             | `standard.components2d`, atlases, 2D render layer, SDF text, `ink/tiles`, `@ink/tiles`, `examples/tiles`                                        | `test:tiles` builds, plays and wins a level, then hot reloads everything                               |
| 12 Iteration      | Frame profiler in every toolbar and over the agent API, per-stage save-to-pixels traces, warm-up worker, faster tuning path                     | Tuning under 50 ms; code reload 242–357 ms except tiles (129 ms), see "Upstream"                       |
| 13 Asset pipeline | `@ink/assets` workers + content-addressed cache, KTX2/Basis, meshopt + LODs, Opus audio, thumbnails, build output                               | 55.6 MB glTF usable in 1.1–1.8 s, full quality in 12–34 s, 13.6 MB in builds                           |

## Verified before this push

On the combined tree with the local `../blot2`:

- `deno task check` clean, `deno task test` 319 passed.
- Browser suites, all passed: `test:scenarios`, `live`, `brushes`, `build`,
  `multiplayer`, `shared`, `render`, `clusters`, `particles`, `animation`,
  `temporal`, `gi`, `sprites`, `tiles`, `physics`, `assets`, `terrain`.

Against Blot2 `86a527b` (the CI pin) in a copy of the tree: `deno task check`,
`deno task test` (319), `deno task ink test` for feel, godot (jump and physics),
trenchbroom, hammer and tiles, and `test:physics` (Chromium matches Deno after
300 steps).

**Not rerun after the final integration:** `test:browser` (all six editors;
terrain alone takes about ten minutes under SwiftShader), `test:world`,
`test:iteration` and `test:terrain-tools`. Each passed when its agent finished.
The last two edits (thumbnail 404 → 204 and the toolbar overflow) were made
after most suites had run. CI has not run on GitHub with the new suites; the
workflow does not yet run `test:physics`, `test:assets` or `test:terrain`.

## Next, in order

1. **Hill 3: prefabs and nested scenes.** Scene-file instances with per-instance
   overrides, editable in place; `*.material.json` assets; spawning a prefab
   from Blot. Gate: TrenchBroom's doors and crates are prefabs and editing the
   prefab updates every instance live, keeping overrides.
2. **Run the unrun suites** above, then push and watch CI. Add `test:physics`
   (fast) to `.github/workflows/check.yml`; decide whether `test:assets` and
   `test:terrain` belong in CI (minutes under SwiftShader).
3. **Measure on a quiet machine.** Every timing in this round was taken at load
   average 15–125, some with a game using the GPU. Rerun `bench:physics`,
   `bench:world`/`test:world`, `test:iteration --hardware --headed` and the
   terrain gate idle, and correct the numbers in `PLAN.md`.
4. **Physics speed.** Cache immovable hulls across steps, a static broad-phase
   structure, no per-pair allocation in the narrow phase (`docs/physics.md`).
5. **Large-world limits.** Instance caps (8192 per level, 4096 per cascade),
   impostors, distance-priority streaming, and faint banding on steep terrain
   slopes (visible on the mountains in `tmp/terrain-gate-fly-*.png`).
6. **Unverified hardware.** No midrange or non-NVIDIA GPU has run the cluster,
   terrain or iteration gates; Windows/macOS packages and Safari audio are
   untested.

## Upstream (Blot2)

The 150 ms code-reload budget is blocked by two stages Ink does not own; see
`docs/iteration.md` ("Upstream") and `docs/blot.md` ("Build times"):

- blotc edit time grows with module size (78 → 201 ms for 459 → 827 KB with the
  same one-number edit); it should follow the size of the change.
- V8 compiles the new module lazily at 1.5 MB/s because functions are huge
  (Godot: 32,467 locals, one 69 KB function with 4,357). Smaller functions,
  reused locals, separately compiled library/codec modules, or per-function
  patching would fix it.
- Compiler quirks found this round are in `docs/blot.md` (`for ever` collects
  every fourth iteration, in-place array updates, `data` is a keyword, one
  spread per list literal, no `else if` statement).

## Housekeeping

- `stash@{0}` still holds the pre-rewrite Blot v1 WIP. The `blot2` branch is
  stale and can be deleted.
- `examples/terrain` data is generated (`deno task gen:terrain`, about 20 s);
  `test:terrain` and `test:browser` generate it when missing.
- Lazy entities (worlds over 1,024 entities) must be copied with `cloneEntity`,
  never spread or `structuredClone`d (`docs/architecture.md`).
