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

Ink uses the Blot compiler from the sibling `../blot` checkout. Its required
revision is `f5041e2a5cef4efec79a899fb29794482ca41ebd`; `pnpm check` verifies
the checkout before checking the workspace.

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

The development app uses Ink's opinionated Vite configuration:

```text
assets/
src/
ink.ts
package.json
```

`ink.ts` is imported as the Vite configuration and executed as the Wasm build
entry, so the installed application does not need separate Vite and build
configuration files:

```ts
import { define_ink_game } from "@ink/vite";

export default define_ink_game({
  app_directory: new URL("./", import.meta.url),
  source_directories: ["src/blot/", "../../packages/blot/"],
  web_directory: "src/",
});
```

The same file uses its `import.meta.main` branch to invoke this example's Blot
builder. An application using another Wasm toolchain can invoke that builder
instead without changing the Vite wrapper.

`@ink/vite` owns the React Compiler, Tailwind, hot reload, asset
synchronization, and production defaults. The app supplies its source
directories, build adapter, artifact loader, and game-specific choices. The
wrapper is language-neutral: its build command must publish a Wasm module and
Ink manifest, whether those files come from Blot, Rust, C, or another Wasm
toolchain.

## Workspace

- `apps/game-dev/` owns the example game, its local Blot toolchain, the
  React/Vite development host, and the JSON Lines headless host.
- `editors/` contains focused platformer, shooter, role-playing, narrative,
  strategy, adventure, and vehicle packages. Each package owns its genre
  vocabulary, pure authoring commands, diagnostics, valid starters, and
  opinionated subgenre presets without widening Ink into a universal editor.
- `packages/blot/` owns reusable Blot lifecycle, stateful ECS, scene,
  HTML-in-Canvas, math, geometry, sprite, tilemap, and flex modules, plus the
  Blot ABI adapter.
- `packages/runtime/` owns the language-independent lifecycle, block graph,
  deterministic channels, save/load, replay, and headless host. The Blot ABI's
  preview session and JSON Lines vocabulary live with `packages/blot/`.
- `packages/development/` owns the Ink Vite plugin, React development surface,
  accessible HTML adapter, and WebGPU renderer.
- `packages/vite/` owns the opinionated, language-neutral Vite configuration
  used by development applications.
- `packages/noise/`, `packages/shaders/`, and `packages/shader-graph/` own
  deterministic procedural fields, composable WGSL contracts, and typed graph
  compilation without owning GPU devices.
- `packages/procedural/` turns versioned recipes into terrain, biome, scatter,
  and signed-distance mesh products.
- `packages/editor-ui/` provides source-owned, accessible editor chrome on the
  headless `@comp0/react` interaction primitives. Specialized editors still own
  their panel composition and domain vocabulary.

`apps/game-dev/src/blot/prelude.blot` is the app's boundary for the compiler's
built-in prelude. `packages/blot/prelude.blot` provides the equivalent boundary
for shared modules. The minimal app keeps its complete guest in one
`src/blot/game/main.blot`. All first-party playable examples use Blot so the
source that creators copy matches Ink's language, Wasm, replay, and headless
paths. External games can still implement the same `GameGuest` contract from
another language.

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
const Scene = @import "../../../../packages/blot/scene.blot" ()

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
</Scene.Camera>
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

The process reads JSON Lines from standard input and writes responses to
standard output. Every request has an `id` and one of `describe`, `reset`,
`step`, `save`, `load`, `finish_replay`, `replay`, `trace`, or `close`. Actions
are discovered from observations instead of inferred from pixels.

Every playable example uses the same observation contract. An agent can call
`describe()` to discover named actions, progress, and status, submit one of
those returned actions to `step()`, and keep playing from the next observation.
Browser agents see the same vocabulary as accessible controls; graphics are
additional context, not the only way to understand or operate the game.

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
let growing_child = fn width => fn () =>
  _ <- Flex.Child.size (#Points width, #Points 10)
  _ <- Flex.Child.grow 1
  return ()

let flex_line = fn () =>
  _ <- Flex.Container.size (110, 40)
  _ <- Flex.Container.direction Flex.row
  _ <- Flex.Container.gap 10
  _ <- Flex.child (growing_child 20)
  _ <- Flex.child (growing_child 30)
  return ()

let frames = Flex.layout flex_line
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
