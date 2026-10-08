# Ink architecture

Ink is a set of building blocks for making the game-development environment a
game needs, in the browser, with Blot for game code. The point is iteration
speed: change code, data, assets or UI and see the result in the running game in
well under a second, without losing where you were.

## Principles

1. **The host owns the state; the game is a pure step function.** The world is a
   numeric packet (`Float32Array`) held by the host. A Blot game exports
   `step : (input, state) -> (state, events)`. Snapshots, undo, save/load,
   rewind, replay, deterministic screenshots, hot reload and agent hand-offs all
   fall out of this: the state is always just there.
2. **One schema describes the data.** Components, resources, events, actions and
   messages are declared once in TypeScript (`schema.ts`). Ink derives the
   packed layout, a typed Blot module (`schema.gen.blot`), scene files, generic
   inspectors and state migration from it.
3. **Edit and play are the same world.** A scene document _is_ a world. Edit
   mode shows and edits it; play runs the game from it; stop returns to it.
   Pause during play to inspect and edit the live world; apply play changes back
   to the scene if you like them.
4. **The UI is ordinary React.** Ink ships composable pieces (viewports,
   outliner, inspector, play controls, console, timeline, comments, hand-off)
   rather than one editor. A game's HUD uses the same hooks as its tools.
5. **Everything an agent needs is a file or a command.** Comments, captures and
   hand-offs are JSON/PNG/Markdown under `.ink/`; `deno task ink capture`
   renders any state from any view headlessly.

## Packages

Source dependencies point toward the more general package.

| Package         | Owns                                                                                                         | Runs in         |
| --------------- | ------------------------------------------------------------------------------------------------------------ | --------------- |
| `@ink/schema`   | Field DSL, `defineSchema`, packet codecs, scene files, Blot codegen, standard components                     | anywhere        |
| `@ink/blot`     | Ink's Blot library (`ink/math`, `ink/input`, `ink/packet`, `ink/random`), `loadGame`; `./compiler` (Deno)    | anywhere / Deno |
| `@ink/core`     | `Session`: edit/play, history, timeline, input mapping, selection, comments, hand-off bundles, headless runs | anywhere        |
| `@ink/geometry` | Vector/matrix/quaternion math, rays, primitive meshes, convex brushes                                        | anywhere        |
| `@ink/render`   | WebGPU renderer: views, scene extraction, materials, lights, grid, lines, picking, capture                   | browser / Deno  |
| `@ink/react`    | UI building blocks and hooks over a `Session` and a renderer                                                 | browser         |
| `@ink/dev`      | Vite plugin (compile, codegen, HMR, dev API), dev client, CLI (`dev`, `capture`, `run`, `gen`)               | Deno + browser  |

Examples under `examples/` compose these into specialized editors with small
games: a Godot-like scene editor, a TrenchBroom-like brush editor and a
Hammer-like four-view editor with entity I/O.

## A project

```
examples/godot/
  ink.config.ts      project settings (paths, title)
  schema.ts          export default defineSchema({...})
  game/main.blot     the game; imports ./schema.gen (generated)
  scenes/main.scene.json
  assets/...         meshes (.glb/.gltf/.obj), textures (.png/.jpg), sounds
  src/app.tsx        the editor UI, composed from @ink/react
  index.html
```

`deno task ink dev examples/godot` starts Vite under Deno with the Ink plugin.

## Data flow

```
schema.ts ──defineSchema──> Schema ──generateBlot──> game/schema.gen.blot
                                 │                         │
scenes/*.scene.json ──sceneToWorld──> WorldModel           game/main.blot
                                 │                         │ blotc (retained session)
                         encodeWorld                       v
                                 v                      game.wasm
                        state: Float32Array ──step──> state', events
                                 │
                 decodeWorld (cached per state)
                                 v
         renderer (extract + draw)  ·  React UI (hooks)  ·  console/audio (events)
```

## Packets

See `packages/schema/codec.ts` for exact lanes. All lanes are F32; integers
(ids, enums, counts, asset ids) are exact below 2^24. The step packet is
`[input lanes, ...input, ...state]`; the result is
`[state lanes, ...state, event count, ...events]`.

## The world model on the host

```ts
interface WorldModel {
  tick: number;
  nextEntity: number;
  seed: number;
  entities: EntityModel[]; // in outliner order
  resources: Record<string, RecordValue>;
}
interface EntityModel {
  id: number;
  parent: number;
  components: Record<string, RecordValue>;
}
```

Values: `f32`/`u32`/`entity`/`asset`/`message` are numbers, `bool` booleans,
`vec2..4`/`quat`/`color` number arrays, `enum` strings, `struct` objects, `list`
arrays. Asset fields hold catalog ids (1-based per kind, 0 = none); scene files
hold asset paths. Entity names are host metadata (`Map<id, string>`), not game
state.

### Standard components

`transform` (position, rotation quat `[x,y,z,w]`, scale; local to parent),
`mesh` (shape asset of kind `mesh`, color, texture, roughness, metallic,
emissive, cast_shadows), `camera` (fov degrees, near, far, orthographic, size,
active; looks down local -Z), `light` (kind directional|point|spot, color,
intensity, range, angle degrees, shadows; directional shines down local -Z),
`brush` (faces: list of
`{ plane [nx,ny,nz,d], texture, color, offset, scale,
rotation }`; the solid is
`n·p <= d` for every face, in local space).

Builtin meshes have catalog paths
`builtin:cube|sphere|plane|cylinder|capsule|cone` (unit-sized: cube is 1×1×1
centred, sphere radius 0.5, plane 1×1 on XZ facing +Y).

## The game in Blot

```blot
import * as array from "std/array"
import * as s from "./schema.gen"
import * as math from "ink/math"

const spin = fn (input: s.Input) => fn (entity: s.Entity) => do:
  let #Some spinner = entity.spinner else:
    return entity
  let #Some transform = entity.transform else:
    return entity
  transform.rotation := self * math.axis_angle math.up (spinner.speed * input.dt)
  entity.transform := #Some transform
  return entity

const update = fn (input: s.Input) => fn (world: s.World) => do:
  world.entities := array.map (spin input) self
  if input.actions.jump.pressed:
    use s.emit (#s.Log { message: s.message_jumped, a: 1.0, b: 0.0 })
  return world

entry const step = fn (lanes: Array F32) -> Array F32 => s.run update lanes
// Optional: runs once when play starts.
entry const start = fn (lanes: Array F32) -> Array F32 => s.run begin lanes
```

The generated module provides the types (`World`, `Entity`, one type per
component/resource, `Input`, `Actions`, `Event`), `default_<component>`,
`blank`, `<kind>_<asset>` and `message_<name>` constants, `spawn`, `despawn`,
`find`, `replace`, `each`, `children`, and the effects `emit`, `random`,
`random_range`. See `docs/blot.md` for language notes.

## Session (`@ink/core`)

One `Session` per running project. It holds the schema, catalog, scene document,
live play world, game instance, history, timeline, selection, comments and
console. UI subscribes to it; the dev client feeds it builds and file changes.
It is DOM-free so headless tools reuse it.

## Renderer (`@ink/render`)

One `Renderer` per GPU device; any number of `View`s, each bound to a canvas or
an offscreen size. `extractScene(world, catalog)` resolves the hierarchy and
standard components into draws; `view.render(scene, camera, overlays)` draws;
`view.pick(x, y)` returns the entity under a pixel; `view.capture()` returns a
PNG. Editor cameras and overlays are presentation-only and never enter game
state.

## Agents

`.ink/` in a project holds what tools and agents exchange:

- `comments.json` — comments pinned to entities or points in the world.
- `captures/<id>.png|.json` — screenshots with the state and view that made
  them.
- `handoffs/<id>/` — `handoff.md`, `state.scene.json`, `inputs.json`,
  `console.json`, screenshots. Written by the hand-off button.

`deno task ink capture <project> [--scene name | --state file | --handoff id]
[--view game|editor|top|front|side] [--out file.png]`
renders a known state headlessly.
`deno task ink run <project> --ticks N [--inputs file]` steps the game without a
browser and prints the resulting world.
