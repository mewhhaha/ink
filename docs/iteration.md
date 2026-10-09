# Iteration speed

Hill 12 asks for a save-to-pixels loop under 150 ms for code and under 50 ms for
tuning values, measured, and visible in the editor. This page says how the loop
is measured, where the time goes, what Ink does about it and what is left for
the Blot compiler.

## The profiler

`session.profiler` (`@ink/core`, `Profiler`) holds two kinds of measurement.

- **Frame metrics**, a rolling window of 120 samples each, summarised as last,
  median, 95th percentile and worst: `step` (the session's game step, all in),
  `guest` (the Wasm call plus packing the input), `decode` (result packet to
  state), `extract` (world to render scene, only when the world changed),
  `render` (CPU time of `view.render`), `gpu` and `frame` (the interval between
  animation frames). `gpu` is the sum of the durations of the frame's render and
  compute passes from WebGPU `timestamp-query`, read back a few frames later;
  the renderer asks for the feature when the adapter has it and `gpuTimestamps`
  says whether it did (SwiftShader reports it, with software timings).
- **Loop traces**: one per change, from the moment its file was written to the
  animation frame after the GPU finished the first frame showing it. A trace is
  a list of timestamps (epoch milliseconds from
  `performance.timeOrigin +
  performance.now()`, which the dev server, the page
  and a test driver on one machine share to well under a millisecond); a stage
  is the time since the previous mark, so stages always add up to the total.
  Kinds: `code` (a `.blot` file), `schema` (`schema.ts`), `scene` (a scene file
  on disk), `asset` (an asset file) and `tuning` (an inspector field or an agent
  `edit`).

`<FrameProfiler />` (`@ink/react`) is a toolbar readout of the three costs that
matter while playing and the last save-to-pixels time; every example puts it
next to `<BuildStatus />`. Click it for all metrics and a stacked bar of each
kind's last trace with its file and stage times (red above the budget). The same
snapshot is `profile` in the live API (`POST /__ink/live/call`, MCP tool
`ink_profile`) and `__ink.profile()` in automation pages.

### Stages

`watch` (file written to the watcher event, from the file's mtime), `queue`
(debounce, schema regeneration), `blotc` (the compiler), `send`, `transport`
(server to page over Vite's websocket), `fetch` (only when the payload did not
travel inside the event), `schema` (import of the new `schema.ts`), `migrate`,
`wasm` (`WebAssembly.compile`), `warm` (see below), `instantiate`, `swap`
(`Session.setGame`), `apply` (a scene or an edit entering the session), `frame`
(waiting for the next animation frame), `step` (the game stepping), `extract`,
`draw` (overlays, gizmos, everything between extraction and submitting),
`render` (CPU submit), `gpu` (until `queue.onSubmittedWorkDone`) and `present`
(the animation frame after that).

## Where the time goes

See "Measured" below for numbers. What dominates, in order:

1. **V8's lazy compilation of the new module.** `WebAssembly.compile` returns in
   a few milliseconds, and `instantiate` takes 0.2 ms: neither is worth
   optimising, and nothing is gained by "patching a running guest instead of
   re-instantiating" while the world lives on the host. But V8 compiles each
   Wasm function on its first call, so the first `step` of a fresh module spends
   100 to 300 ms compiling everything that step reaches (a 440 KB game such as
   Godot compiles about 250 ms of CPU, measured in Deno and in Chromium, with
   `--no-wasm-lazy-compilation` too: the work is the same, eager compilation
   only spreads it over threads). Ink moves that cost out of the page's main
   thread: after compiling, `warmGame` runs one throwaway step of the new module
   in a worker (a `WebAssembly.Module` posted to a worker shares its compiled
   code; the main thread's first real step then takes 1 ms instead of 200),
   while the old game keeps stepping. It does not make the loop shorter, only
   smooth.
2. **blotc.** An incremental build of an edited entry module takes 20 ms
   (terrain, tiles) to 55 to 75 ms (Godot, Feel, TrenchBroom, Hammer) on a
   loaded machine, the backend `generate` phase being most of it. See "Upstream"
   below.
3. **Frame pacing and the GPU**, for tuning: one wait for the next animation
   frame, the render, the GPU and the frame after it.

## What Ink skips

- Builds whose Wasm is byte-identical to the running module (a comment, an edit
  the optimizer erased, a schema default the game never reads) are not
  transferred or swapped; the editor is told `unchanged`.
- A small module (up to 8 MB) travels as base64 inside the `ink:game` event, a
  scene file under 256 KB inside `ink:scene`: no second request.
- The watcher debounces for 5 ms (an editor that truncates and then writes needs
  the second event), scenes wait for a file that parses.
- `setProject` keeps packed worlds untouched when the schema's layout hash and
  the catalog are unchanged (a default, label or range edit): `migrate` is 0.1
  ms.
- A change made between animation frames (an inspector field, a file reloaded
  from disk) is drawn in the same task when the GPU is idle, and as soon as it
  is free otherwise, instead of at the next animation frame: the GPU works while
  the browser waits for the vsync.
- A scene file edited on disk while the game runs also changes the live world:
  changed component and resource values of entities that exist in both are
  copied over, so tuning a number in the file is seen at once.

## The gate

`deno task test:iteration` copies each example into `tmp/iteration/`, starts its
dev server and a Chromium editor, presses play and then edits, in turns, a
number in the game's Blot code, a schema default, a position in the scene file,
a component value through the live API (the path of an inspector field) and,
where the example has one, a texture. It reads the editor's own traces back and
prints median and 95th percentile per kind with the median of every stage.
Options: `--hardware --headed` (real GPU, desktop Chromium; software adapters
are rejected and the budgets asserted on the medians), `--example=godot,feel`,
`--iterations=12`, `--no-assert`.
`tmp/iteration-report-<software|hardware>.json` keeps the figures.
`deno run -A scripts/compile-bench.ts hammer
--sizes=0,100,400` times blotc
alone on an example padded with generated systems.

## Measured

RTX 4080 SUPER, headed Chromium, 2026-10-09, machine load average 14 to 30
(other agents building, a game on the GPU), medians of 12 edits, milliseconds.
`deno task test:iteration --hardware --headed`:

| Example     | Code | Schema | Scene (play / paused) | Tuning API (play / paused) | Inspector (play / paused) | Texture |
| ----------- | ---: | -----: | --------------------: | -------------------------: | ------------------------: | ------: |
| feel        |  285 |     70 |               34 / 21 |                    29 / 17 |                         – |       – |
| godot       |  332 |     62 |               46 / 41 |                    18 / 21 |                   30 / 22 |       – |
| tiles       |  129 |     52 |               29 / 43 |                    16 / 20 |                         – |      50 |
| trenchbroom |  357 |      – |               56 / 26 |                    21 / 18 |                   33 / 22 |       – |
| hammer      |  242 |      – |               39 / 35 |                    18 / 14 |                   28 / 27 |      38 |

Stages of a code reload (medians): Godot, 440 KB of Wasm: watcher 3, debounce 6,
blotc 76, websocket 10, Wasm compile 8, lazy compile in the worker 208, frame
wait 11, render 3, GPU 7 = 333. Tiles, 138 KB: 3, 6, 31, 3, 2, 69, 3, 2, 5 =
129. A tuning edit while playing: apply 0.5, frame wait 9 to 11, render 2, GPU 7
to 10 = 18 to 29. The first run, before the changes below, on the same Godot
with the machine at load 63: watch 5, debounce 13, blotc 96, fetch 15, a 194 ms
first step of the new module on the main thread, frame 9, GPU 18, 377 total;
tuning was 34 to 81 ms (inspector 47) and a scene file 75 to 192.

What brought tuning down: the page draws a change made between animation frames
at once (the GPU works while the browser waits for the vsync), a scene file
travels inside its event and also tunes the live world, schema edits that leave
the layout alone do not wait for a rebuild, and a repeated file event for the
same save no longer starts a second build. SwiftShader reports its numbers
without asserting: it draws one frame in 0.2 to 2 s under this load, which is
the whole `gpu` stage.

The gate asserts the medians and, for Godot, Feel, TrenchBroom and Hammer, the
150 ms code budget fails; see the first item under "Where the time goes" and
`docs/blot.md`.

## Upstream (Blot2)

Nothing here needed a change to `../blot2`. What would shorten a code reload,
from the figures above:

1. **An edit should cost in proportion to the change.** blotc takes 78, 110 and
   201 ms for the same one-number edit as Hammer's Wasm grows from 459 to 551 to
   827 KB (`scripts/compile-bench.ts`), 48 to 98 ms of it in the backend
   `generate` phase.
2. **Wasm that is cheaper for V8 to compile.** The first call of Godot's module
   compiles about 250 ms of Liftoff code (1.5 to 1.7 MB/s), whichever way V8 is
   asked to do it. It has 32,467 locals in 357 functions, the biggest function
   is 69 KB with 4,357 locals. Reusing local slots, not inlining the whole
   `update` into one function, or emitting separately compiled modules for the
   library and the schema codec (so an edit recompiles one) would all cut it;
   per-function patching through a `call_indirect` table would make a reload
   independent of the game's size, which is what "patching a running guest"
   needs.
3. Literal edits that patch the old Wasm (blot2's hill 6) would make a number in
   code a tuning value.
