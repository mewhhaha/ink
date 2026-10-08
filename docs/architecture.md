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
   packed layout, typed Blot and TypeScript modules (`schema.gen.blot`,
   `schema.gen.ts`), scene files, generic inspectors and state migration from
   it.
3. **Edit and play are the same world.** A scene document _is_ a world. Edit
   mode shows and edits it; play runs the game from it; stop returns to it.
   Pause during play to inspect and edit the live world; apply play changes back
   to the scene if you like them.
4. **The UI is ordinary React.** Ink ships composable pieces (viewports,
   outliner, inspector, play controls, console, timeline, comments, hand-off)
   rather than one editor. A game's HUD uses the same hooks as its tools.
5. **Everything an agent needs is a file or a command.** The dev server exposes
   the open editor's session through HTTP and MCP, including edits, stepping,
   replay, captures, source changes and comment threads. Comments, captures and
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
| `@ink/player`   | Shipping runtime, device input, audio, controls and the standalone game page                                 | browser         |
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
`deno task ink build examples/godot` creates a standalone static player;
`--desktop` also packages a native application. See `docs/builds.md`.

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
  nameId?: number; // host text symbol, `name_id` in Blot
  components: Record<string, RecordValue>;
}
```

Values: `f32`/`u32`/`entity`/`asset`/`message` are numbers, `bool` booleans,
`vec2..4`/`quat`/`color` number arrays, `enum` strings, `struct` objects, `list`
arrays. Asset fields hold catalog ids (1-based per kind, 0 = none); scene files
hold asset paths. Entity name text stays on the host (`Map<id, string>`), while
the packet carries a deterministic 24-bit symbol. `schema.names` declares
aliases such as `{ player: "Player" }`, generating `s.name_player` for Blot.
Compare `entity.name_id` with that constant, or set it when spawning. Scene
loading rejects collisions between different names.

The compiler also writes `game/schema.gen.ts`. Bind React hooks once with
`createSchemaHooks<World>()`; `useResource("score")`, component access and world
queries then use the generated types. `schema.messages` is the default language;
`schema.locales` maps locale names to translated messages. A session's
`setLocale` changes presentation without changing the packet. `useMessages`
formats numeric or string arguments, with missing translations falling back to
the default text; `<LanguageSelect />` provides an optional language control.

### Standard components

`transform` (position, rotation quat `[x,y,z,w]`, scale; local to parent),
`mesh` (shape asset of kind `mesh`, color, texture, roughness, metallic,
emissive, cast_shadows, alpha_mode, alpha_cutoff, double_sided, use_materials),
`animation` (clip/time/loop and previous clip/time/loop plus blend; no hidden
animation clock), `attachment` (target model entity and posed glTF node),
`emitter` (tick/seed, rate, lifetime, motion, size and color; particles remain
GPU presentation), `camera` (fov degrees, near, far, orthographic, size, active;
looks down local -Z), `light` (kind directional|point|spot, color, intensity,
range, angle degrees, shadows; directional shines down local -Z), `brush`
(faces: list of
`{ plane [nx,ny,nz,d], texture, color, offset, scale,
rotation, uv_u, uv_v }`;
the solid is `n·p <= d` for every face, in local space). The affine UV axes
`[x,y,z,offset]` retain texture mapping through shears, mirrored transforms and
CSG; zero axes choose the normal-based default.

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

Network play attaches a `MultiplayerPlay` driver to that same session. The pure
`Rollback` engine exchanges canonical per-player inputs, predicts controls,
replays from keyframes and compares confirmed state hashes. Corrections replace
the timeline's inputs and snapshots; a disconnected game remains inspectable.
See `docs/multiplayer.md`.

Shared editing attaches a separate `SharedSession` document driver. Scene fields
and comment threads merge through Lamport-clock CRDT registers, while personal
selection/cameras travel as transient presence. The driver supplies conditional
undo and reserved entity ids; the ordinary scene JSON remains the saved
artifact. See `docs/shared-sessions.md`.

## Renderer (`@ink/render`)

One `Renderer` per GPU device; any number of `View`s, each bound to a canvas or
an offscreen size. `extractScene(world, catalog)` resolves the hierarchy and
standard components into draws; `view.render(scene, camera, overlays)` draws;
`view.pick(x, y)` returns the entity under a pixel; `view.capture()` returns a
PNG. Editor cameras and overlays are presentation-only and never enter game
state.

Presentation events retain a bounded history outside the game packet. The
renderer reconstructs continuous particle emitters and `particles` event bursts
from tick/seed; seeking and rollback replace event history without replaying
audio. Handoffs include still-live events before their keyframe as well as
recorded inputs after it.

glTF assets keep their hierarchy, materials, skins, morph targets and animation
clips. Component values determine each pose, and every geometry pass shares the
same GPU deformation. `extractScene` accepts the asset store to resolve posed
node attachments. The frame loop advances the game on every RAF, but bounds GPU
work to one in-flight editor frame so a slow adapter cannot accumulate minutes
of queued draws. Renderers prefer a high-performance adapter; callers can pass
`powerPreference: "low-power"` or supply a device explicitly.

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
