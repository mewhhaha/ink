# Ink Engine

Ink Engine is a block-based Deno Desktop game-engine foundation. The editor is
intentionally narrow: one WebGPU canvas, a synchronized semantic HTML layer, and
play, pause, and stop controls. The bundled Scene Explorer game is written in
Blot and compiled to Core WebAssembly.

The first render block loads a bundled OBJ mesh and draws the game’s three
beacons with depth-tested WGSL lighting. Each model is paired with a visible
native HTML button using bounds emitted by the same Blot game state.

Ink is a foundation for building a game engine, not a finished engine with one
prescribed workflow. Games are assembled from replaceable blocks with explicit
interfaces. Game code lives in WebAssembly; Blot is a first-class source
language, but the runtime contract is language-independent. Reusable WebAssembly
components provide common engine capabilities without making them mandatory.

Accessibility, observability, deterministic testing, save/load, replay, and hot
reload are runtime contracts rather than editor add-ons. A game describes its
meaningful state and available actions as well as its render commands. See
[docs/architecture.md](docs/architecture.md) for the design principles guiding
that work.

## Run it

```sh
deno task dev
```

This builds the Blot blocks and game, opens the CEF desktop window in HMR mode,
and watches Blot sources. A compatible game rebuild preserves guest state; an
incompatible schema visibly resets it. `deno task serve` is available when a
browser tab is more convenient.

For a distributable desktop build using the bundled Chromium Embedded Framework
(CEF) backend:

```sh
deno task desktop
```

The desktop task compiles React with React Compiler, builds the Tailwind CSS and
browser bundle, compiles the game through `../blot`, embeds `public/`, and
writes the platform-specific artifact under `dist/`. Generated browser and Wasm
files are not source.

## Headless and agent use

`deno task headless` starts a JSON Lines protocol on standard input and output.
Every request has an `id` and one of `observe`, `reset`, `step`, `save`, `load`,
`finish_replay`, `replay`, `trace`, or `close`. Actions are discovered from the
observation instead of inferred from pixels.

```json
{"id":1,"command":"observe"}
{"id":2,"command":"step","action":{"type":"activate","target":0}}
{"id":3,"command":"save"}
```

The TypeScript API exposes the same session and operations. Tests assemble game
scenarios with `Program`, interpret them against a real Wasm session, and assert
only on public observations.

## Checks

```sh
deno task check
deno task test
deno lint
```

The editor boundary is split into three small pieces:

- `editor/logic.ts` contains immutable playback state and actions composed with
  typeclasses `Do`, `Program`, and `State`.
- `runtime/` owns the Wasm ABI, semantic observations, block graph, strict
  saves, replay, hot reload, and effect-driven headless session.
- `editor/main.tsx` is the React view and HTML accessibility adapter;
  `editor/webgpu.ts` is the WGSL/WebGPU edge.
- `blocks/blot/` contains the first reusable math, geometry, sprite, and tilemap
  blocks, plus a pure flex-layout library; `games/scene_explorer/main.blot` is
  the example guest.
- `main.ts` serves the shell and generated client from Deno Desktop’s local HTTP
  server.

## Flex layout library

`blocks/blot/flex.blot` implements Yoga-style single-line flex layout as a pure
Blot module. `Flex.layout` accepts one `Flex.ContainerStyle` and an array of
`Flex.ChildStyle` records, then returns an equally ordered array of `Flex.Frame`
records. Coordinates and flex weights are integers; division assigns any
remainder to later flexible children so the available main-axis space is used
deterministically.

The module supports row, row-reverse, column, and column-reverse directions;
flex basis, grow, and basis-scaled shrink; per-edge margin and padding; gap; all
Yoga main-axis justification modes; cross-axis stretch, start, centre, and end;
and `align_self`. Use `Flex.auto_size` for an automatic width, height, or flex
basis. The executable examples in `blocks/blot/testdata/` show the complete
style records.

This source-level block deliberately stops at single-line layout. Flex wrapping,
absolute positioning, percentages, intrinsic measurement, min/max constraints,
aspect ratio, baselines, and recursive tree traversal require a larger layout
model and are not presented as supported Yoga behavior here.
