# Ink

Ink is a foundation for focused game-development applications. Game rules run as
Blot WebAssembly guests; TypeScript owns the editor, browser host, WebGPU
presentation, hot reload, replay, and headless verification.

The workspace currently contains four deliberately small 3D applications:

- `apps/dungeon-dev` is the editable third-person dungeon. Its Blot guest owns
  the brass key, oak gate, and exit-room playthrough.
- `apps/visual-novel-dev` is a moonlit 3D station scene with a branching
  Divi-Dead-style dialogue game. Editing a beat rebuilds and reloads its Blot
  guest.
- `apps/shrubbery-dev` is a browser-sized version of Blot's Shrubbery loop. A
  Blot guest generates selectable oak, fir, flower, rock, and mixed voxel
  recipes for the WebGPU host.
- `apps/lighting-dev` is a Bevy-inspired material and lighting testbed with
  directional shadows, point and spot lights, metallic/rough materials, emissive
  HDR, bloom, fog, exposure, and ACES tone mapping.

All four applications compose an ordinary HTML entry with stable
`@ink/rendering` WebGPU code. The lighting, shrubbery, and visual-novel scenes
share the compact `@ink/rendering/simple3d.ts` renderer; the dungeon retains its
specialized renderer and editor.

## Run an application

Install pnpm 10, keep the Blot checkout at `../blot`, then run one application:

```sh
pnpm install
pnpm dev:dungeon
pnpm dev:visual-novel
pnpm dev:shrubbery
pnpm dev:lighting
```

Each command starts Vite and prints its local URL. Ink uses the current sibling
Blot working tree, including uncommitted compiler changes.
`pnpm check:blot-toolchain` compiles, instantiates, and executes the ABI fixture
with that exact tree.

The renderer requests a high-performance WebGPU adapter and rejects software
fallback. On Linux, `chrome://gpu` must report hardware-accelerated WebGPU; the
browser application reports a clear error when no suitable adapter is available.

## Headless play

The gameplay applications also run without a browser:

```sh
pnpm headless:dungeon
pnpm headless:visual-novel
```

The application tests compile the real Blot guest, edit temporary project
copies, rebuild, play the authored outcome, and verify replay parity. The
shrubbery test executes its Wasm guest and compares generated recipes.

## Architecture

Source dependencies point from a concrete layer toward a general one:

```text
core packages <- specialized editor <- development application
```

Core packages own game-neutral contracts. Editors own genre documents, commands,
validation, serialization, and focused React workspaces. Applications own Blot
gameplay, project compilation, assets, spatial bindings, and presentation
composition. `pnpm check:workspace` enforces these boundaries, and
`pnpm check:examples` enforces the four-application suite.

See [docs/architecture.md](docs/architecture.md) for the runtime and package
contracts.

## Verification

```sh
pnpm check
pnpm test
pnpm build
pnpm test:browser:visual-novel
```

Blot owns its own style checks:

```sh
cd ../blot
deno fmt --check
deno lint
```
