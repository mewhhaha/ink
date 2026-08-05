# Ink Engine

Ink is a block-based foundation for building game engines. Game logic runs in
WebAssembly, while a small TypeScript host provides rendering, accessible HTML
interactions, observability, hot reload, save/load, replay, testing, and
headless execution.

The development app deliberately stays small: one WebGPU canvas containing one
native semantic button, plus native play, pause, and stop buttons. Its Blot
guest is one file with one object and one state transition.

## Development

Install pnpm 10, then run:

```sh
pnpm install
pnpm dev
```

The isometric map specialization runs separately:

```sh
pnpm dev:city
```

The Blot Doom arena runs separately:

```sh
pnpm dev:doom
```

Vite opens the React app and hot-reloads TypeScript and CSS. Ink's Vite plugin
also watches the app's Blot sources and the shared `@ink/blot` sources, rebuilds
their Wasm artifact through Deno, and keeps the last successful artifact
available when compilation fails. A compatible game rebuild preserves guest
state; an incompatible schema visibly resets it. Asset edits bypass the Blot
compiler: the plugin copies only the changed resource and asks the renderer to
replace its GPU asset in place.

Blot's generated parser and final compiler both run as WebAssembly. Development
builds start no compiler service, request no GPU adapter, and keep no native
compiler process alive between edits.

The canvas uses Chrome's experimental HTML-in-Canvas API. Run Chrome 148 through
150 with `chrome://flags/#canvas-draw-element` enabled, or enable the matching
origin trial for the development origin. On Linux, also enable
`chrome://flags/#enable-vulkan` and `chrome://flags/#enable-unsafe-webgpu`. Ink
requests a high-performance WebGPU adapter and declines software fallback;
`chrome://gpu` must report WebGPU as hardware accelerated.

The development app composes Ink with ordinary Vite plugins:

```ts
import { ink } from "@ink/development/vite.ts";
import react from "@vitejs/plugin-react";
import { game_development } from "./development.ts";

export default {
  plugins: [ink(game_development), react()],
};
```

The app supplies the game build adapter, artifact loader, React choices, and
build-tool choices. Ink supplies the reusable `game_development` React surface
and Vite plugin. React Compiler and Tailwind are enabled by the example app
without becoming runtime requirements.

## Workspace

- `apps/game-dev/` owns the example game, its local Blot toolchain, the
  React/Vite development host, and the JSON Lines headless host.
- `apps/isometric-city-dev/` is a copyable map template. It owns a thirty-two by
  thirty-two isometric terrain scene, its Blot rules, tileable grass, sand, and road
  materials, connectable road meshes, immigration, housing needs, fire response,
  and its build configuration. The map exposes named tile regions and a movable
  debugger over one HTML-in-Canvas surface.
- `apps/doom/` is a compact first-person arena written entirely in Blot. It reuses
  the shared cube mesh, renders walls and enemies through the canvas scene contract,
  and paints its health, controls, and status as native HTML-in-Canvas elements.
- `packages/blot/` owns reusable Blot lifecycle, stateful ECS, scene,
  HTML-in-Canvas, math, geometry, sprite, tilemap, and flex modules, plus the
  Blot ABI adapter.
- `packages/engine/` owns the language-independent Wasm ABI, block graph,
  observations, save/load, replay, and headless session.
- `packages/development/` owns the Ink Vite plugin, React development surface,
  accessible HTML adapter, and WebGPU renderer.

`apps/game-dev/blot/prelude.blot` is the app's boundary for the compiler's
built-in prelude. `packages/blot/prelude.blot` provides the equivalent boundary
for shared modules. The minimal app keeps its complete guest in one
`blot/game/main.blot`. Other languages can replace Blot by producing the same
`GameGuest` contract.

The pnpm workspace catalog pins shared dependency versions. Lifecycle scripts
are allowed only for packages in the `@comp0/*` and `@mewhhaha/*` scopes; all
unlisted dependency build scripts remain disabled.

## Scene and semantic blocks

`@ink/blot` exposes a fixed-point scene vocabulary that is independent of the
example game. Positions, scales, colors, and semantic plane sizes use one
million units per whole value; rotations use microradians. Objects have local
transforms, optional parents, inherited visibility, a base color, and an
emissive value. The host resolves the hierarchy before drawing the scene or its
attached HTML. Each object selects a mesh identity from the asset registry
supplied by its development app.

```blot
const Scene = (@import "../../../../packages/blot/scene.blot") ();

_ <- <Scene.Camera .projection={Scene.perspective}>
  _ <- <Scene.Object
    .id={1}
    .mesh={0}
    .parent={Scene.root}
    .transform={Scene.transform (
      Scene.vec3 (0, 0, 0),
      Scene.vec3 (0, 0, 0),
      Scene.uniform_scale 1000000
    )}
    .material={Scene.material (Scene.color (400000, 800000, 1000000), 200000)}
    .visible={True}
  />
</Scene.Camera>;
```

Native `<button>`, `<span>`, and `<progress>` elements are described with
`Html.Button`, `Html.Text`, and `Html.Progress`. Each element attaches to a
scene object with a local 3D offset and plane size, or to a viewport corner with
a pixel inset. Its accessible name, description, DOM order, dimensions, state,
and game-authored style cross the same typed Wasm effect boundary. `Html.Action`
exposes non-spatial commands and `Html.Status` publishes announcements. Scalar
math, vectors, projection geometry, sprites, tilemaps, and flex layout are
separate reusable blocks so a genre editor can choose only the capabilities it
needs.

The tilemap block uses mathematical floor division for deterministic negative
coordinates and provides checked rectangular indexing plus parameterized
orthogonal and isometric tile/world conversion. Genre rules remain outside core.

## Headless and agent use

```sh
pnpm headless
```

Use `pnpm headless:city` for the isometric map template.

The process reads JSON Lines from standard input and writes responses to
standard output. Every request has an `id` and one of `describe`, `reset`,
`step`, `save`, `load`, `finish_replay`, `replay`, `trace`, or `close`. Actions
are discovered from observations instead of inferred from pixels.

```json
{"id":1,"command":"describe"}
{"id":2,"command":"step","action":{"type":"activate","target":0}}
{"id":3,"command":"save"}
```

Tests compose scenarios with `Program`, interpret them against a real Wasm
session, and assert on public observations. Ink-owned TypeScript functions use
`snake_case`; host logic uses `Do` and `Program` from `@mewhhaha/typeclasses` at
effect and interpreter boundaries.

## Verification

```sh
pnpm check
pnpm test
pnpm build
deno lint
```

See [docs/architecture.md](docs/architecture.md) for the runtime and block
contracts.

## Flex layout block

`packages/blot/flex.blot` implements deterministic, single-line flex layout with
scoped Blot effects. Container and child declarations compose as ordinary
computations, and the layout handler resolves them into frames:

```blot
let growing_child = fn width => fn () => do
  let _size = Flex.Child.size (#Points width, #Points 10);
  let _grow = Flex.Child.grow 1;
  in ()
end;

let flex_line = fn () => do
  let _size = Flex.Container.size (110, 40);
  let _direction = Flex.Container.direction Flex.row;
  let _gap = Flex.Container.gap 10;
  let _first = Flex.child (growing_child 20);
  let _second = Flex.child (growing_child 30);
  in ()
end;

let frames = Flex.layout flex_line;
```

Declarations use defaults when omitted, and later declarations override earlier
ones. Lengths are `#Auto` or `#Points value`; margin and padding accept
`#All value`, `#Axes (horizontal, vertical)`, or `#Edges { ... }`. The block
supports row and column directions, reverse directions, basis, grow,
basis-scaled shrink, gap, justification, cross-axis alignment, and per-child
alignment. Executable examples live under `packages/blot/testdata/`.

Wrapping, absolute positioning, percentages, intrinsic measurement, min/max
constraints, aspect ratio, baselines, and recursive tree traversal require a
larger layout model and are intentionally outside this block.
