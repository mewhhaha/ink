# Ink

Building blocks for making the game-development environment your game needs — in
the browser, with [Blot](../blot2) for game code — and iterating on it fast.

Ink is not one editor. It is a session model, a WebGPU renderer, a dev server
with in-place hot reload, and a set of React components (viewports, outliner,
inspector, play controls, console, timeline, comments, hand-offs, command
palette) that you compose into the tool a particular game wants. The `examples/`
show very different editors built from the same parts, from a 3D brush editor to
a tile editor.

## What it is like to use

- **Change anything, keep playing.** Save a `.blot` file and the running game
  switches to the new code in a few hundred milliseconds with its state intact.
  Edit the schema and every world migrates field by field. Replace an asset and
  it reloads in place. Edit the editor's own React code and Fast Refresh keeps
  the session. A compile error shows over the view while the last good build
  keeps running.
- **Edit and play are one world.** A scene is a world. Press F5 to play it;
  pause and select, move or retune anything in the live game; scrub the timeline
  back (inputs are replayed deterministically); stop to return to the scene, or
  apply what you changed in play back to it.
- **Flip to the game.** Ctrl+G turns the editor into the game alone, full
  window, with a small dock. Pause and click anything in the game to inspect and
  change it right there.
- **Talk to agents with files.** Press C and click in any view to pin a comment
  to an entity (it follows the entity) or a spot. Ctrl+Shift+H writes a hand-off
  — your note, screenshots, the exact state, a replay of the last seconds, open
  comments, console and build errors — and puts a prompt for an agent on the
  clipboard. Agents render any state from any view headlessly with
  `deno task ink capture`.

## Rendering

One WebGPU renderer for editors, games and headless captures: an HDR pipeline
with auto exposure, bloom, AgX/ACES/neutral tonemapping, grading, vignette and
grain; physically based materials with normal, ORM and emissive maps; a physical
sky that lights the scene through prefiltered image-based light; cascaded sun
shadows plus spot and point light shadows with soft, contact-hardening
penumbrae; ground-truth ambient occlusion; height fog with sun in-scattering; up
to 64 lights; built-in noise textures. The scene's `environment` component
drives it, so a game can run its own day/night cycle. Editor overlays (grid,
gizmos, outlines) stay out of the lighting. 2D has its own layer: crisp sprites
from atlas files, one-quad tile maps, normal-mapped 2D lights with tile shadows
and scalable outlined text. See
[packages/render/README.md](packages/render/README.md) and
[docs/2d.md](docs/2d.md).

## Run an example

Requires Deno 2, Zig-built Blot in `../blot2` (`deno task package:build` there),
and Chrome with WebGPU.

```sh
deno task dev:godot        # Godot-style scene editor + a third-person collector
deno task dev:trenchbroom  # TrenchBroom-style brush editor + an FPS walkaround
deno task dev:hammer       # Hammer-style four-view editor with entity I/O
deno task dev:feel         # a game-feel bench: tuning sliders, jump arcs, live plots
deno task dev:tiles        # a 2D tile editor and a platformer: paint, place, play in place
```

## How it fits together

```
schema.ts ─────────► schema.gen.blot ──► game/main.blot ──blotc──► game.wasm
    │                                                                 │
    ▼                                                                 ▼
 Session: scene document · live world · history · timeline   step(input, state)
    │         ▲                                                 → (state, events)
    ▼         │ edits, input
 renderer + React building blocks (your editor)
```

- The **schema** (`schema.ts`) declares components, resources, events, input
  actions and messages once. Ink generates a typed Blot module from it, packs
  worlds into numeric state, writes readable scene files and builds inspectors.
- The **game** is a pure Blot function `step : (input, world) -> world` that may
  emit events and draw random numbers. The host holds the state, which is what
  makes undo, rewind, replay, hot reload and hand-offs simple.
- The **session** (`@ink/core`) owns the document and live world, history,
  timeline, input mapping, selection, comments and console. It has no DOM, so
  the CLI uses it too.
- The **UI** (`@ink/react`) is ordinary React over the session and renderer.

Read [docs/architecture.md](docs/architecture.md) for the design,
[docs/building-blocks.md](docs/building-blocks.md) to make your own editor,
[docs/blot.md](docs/blot.md) before writing game code, and
[docs/agents.md](docs/agents.md) for the agent workflow.

## Packages

| Package         | What it gives you                                                                  |
| --------------- | ---------------------------------------------------------------------------------- |
| `@ink/schema`   | Field DSL, packed codecs, scene files, migration, Blot code generation             |
| `@ink/blot`     | Ink's Blot library (`ink/math`, `ink/collide`, ...), game loading, the compiler    |
| `@ink/core`     | `Session`, input mapping, timeline, comments, hand-offs, headless runs             |
| `@ink/geometry` | Vectors, matrices, quaternions, rays, primitive meshes, convex brushes             |
| `@ink/render`   | WebGPU renderer: lit/unlit/wireframe, shadows, grid, lines, picking, capture       |
| `@ink/react`    | Viewports, gizmos, outliner, inspector, toolbars, console, timeline, comments, ... |
| `@ink/brushes`  | Brush-editing tools and panels for level editors                                   |
| `@ink/dev`      | Vite plugin, dev client, CLI (`dev`, `check`, `gen`, `run`, `capture`, ...)        |

## Commands

```sh
deno task ink dev <project> [--port N]
deno task ink check <project>                 # compile the game, print diagnostics
deno task ink run <project> --ticks 600       # step headlessly, print the world
deno task ink capture <project> --view game,top,iso [--scene s | --state f | --handoff id]
deno task ink comments <project>              # open comments
deno task ink handoffs <project> --latest     # the latest hand-off
deno task test
deno task check
```

## Starting a project

Copy `examples/godot` and change it. A project is `ink.config.ts`, `schema.ts`,
`game/main.blot`, `scenes/*.scene.json`, `assets/`, and a React app
(`index.html`, `src/`). `deno task ink dev path/to/project` serves it.
