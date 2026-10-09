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

| Package         | Owns                                                                                                                     | Runs in         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------- |
| `@ink/schema`   | Field DSL, `defineSchema`, packet codecs, scene files, Blot codegen, standard components                                 | anywhere        |
| `@ink/blot`     | Ink's Blot library (`ink/math`, `ink/input`, `ink/packet`, `ink/random`, `ink/physics`), `loadGame`; `./compiler` (Deno) | anywhere / Deno |
| `@ink/core`     | `Session`: edit/play, history, timeline, input mapping, selection, comments, hand-off bundles, headless runs             | anywhere        |
| `@ink/geometry` | Vector/matrix/quaternion math, rays, primitive meshes, convex brushes                                                    | anywhere        |
| `@ink/assets`   | Import on save: KTX2/Basis textures, meshopt and LOD glTF, Opus audio, content-addressed cache, worker pool              | Deno            |
| `@ink/render`   | WebGPU renderer: views, scene extraction, materials, lights, grid, lines, picking, capture                               | browser / Deno  |
| `@ink/player`   | Shipping runtime, device input, audio, controls and the standalone game page                                             | browser         |
| `@ink/react`    | UI building blocks and hooks over a `Session` and a renderer                                                             | browser         |
| `@ink/tiles`    | Tile map editing: paint, erase, rectangle, fill and picker tools, auto-tiling, tileset palette and layers                | browser         |
| `@ink/terrain`  | Terrain and scatter editing: raise, lower, smooth, flatten, noise, paint and instance brushes, undo, saving to disk      | browser         |
| `@ink/dev`      | Vite plugin (compile, codegen, HMR, dev API), dev client, CLI (`dev`, `capture`, `run`, `gen`)                           | Deno + browser  |

Examples under `examples/` compose these into specialized editors with small
games: a Godot-like scene editor, a TrenchBroom-like brush editor, a Hammer-like
four-view editor with entity I/O and a tile editor for 2D platformers.

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
Imported assets (compressed textures, optimised models, Opus) are described in
`docs/assets.md`. `deno task ink build examples/godot` creates a standalone
static player; `--desktop` also packages a native application. See
`docs/builds.md`.

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
                 decodeWorld (lazy: an entity decodes on use)
                                 v
         renderer (extract + draw)  ·  React UI (hooks)  ·  console/audio (events)
```

## Packets

See `packages/schema/codec.ts` for exact lanes. All lanes are F32; integers
(ids, enums, counts, asset ids) are exact below 2^24. The step packet is
`[input lanes, ...input, ...state]`; the result is
`[state lanes, ...state, event count, ...events]`. The generated `encode_result`
sizes the state, allocates the result once and writes every lane in place;
`decodeWorld`, `encodeWorld` and the event codecs use per-record closures built
once per schema (no field paths or intermediate arrays are built per step).

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

`decodeWorld` decodes a world of up to 1,024 entities (`LAZY_ENTITIES`) into
plain objects. A larger world is lazy: each entity is a `PackedEntity` that
reads its id, parent and name when the world is decoded, and decodes a component
record the first time `entity.components` is used; the record is then an
ordinary, cached object. `hasComponent(entity, name)`,
`componentOf(entity,
name)` and `componentNames(entity)` answer from the packet
without decoding the others (and work on plain entities too), and
`plainWorld(world)` decodes everything (comparisons, serialization). Entities
read from the packet they came from, so a state array must not change after it
is decoded. Copy a lazy entity with `cloneEntity`; `structuredClone` refuses it
and a spread would lose its components. An entity nobody touched is copied back
verbatim by `encodeWorld`, and `cloneWorld(world)` forks lazy entities instead
of cloning them: `Session.edit` costs what the recipe touches, not the size of
the world.

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

`terrain` and `scatter` (large worlds, `docs/terrain.md`), `transform`
(position, rotation quat `[x,y,z,w]`, scale; local to parent), `mesh` (shape
asset of kind `mesh`, color, texture, roughness, metallic, emissive,
cast_shadows, alpha_mode, alpha_cutoff, double_sided, use_materials),
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

Static brushes receive progressive GPU lightmaps when `environment.indirect` is
enabled. `brush.bake_lighting` excludes moving geometry; static meshes may opt
in as bake contributors. `reflection_probe` entities own local reflection boxes,
while `environment.reflections` enables screen-space reflections. These bakes
and temporal histories belong to renderer views, outside the game world.

2D uses the same world and session: `standard.components2d` adds `sprite`,
`tilemap` (tile ids in `cells`, a list of the world), `light2d` and `text`;
atlas files (`*.atlas.json`) name image frames, animations and tile flags and
generate `frame_<atlas>_<name>`, `anim_...` and `tileflags_<atlas>` constants
for Blot. See `docs/2d.md`.

`collider`, `body` and `character` (with the `physics` resource) give shapes,
rigid bodies and a character controller to the Blot physics library; see
`docs/physics.md`.

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

The session owns a `Profiler` (`session.profiler`): per-frame step, decode,
extraction, render and GPU costs, and the stages of every code, schema, scene,
asset and tuning change from file write to the first presented frame. The
toolbar's `FrameProfiler`, the live API's `profile` method and
`deno task test:iteration` read it; see `docs/iteration.md`.

## Large worlds

Hill 1 asked for 20,000 entities stepping at 60 Hz with snapshots, rewind, hot
reload and byte-identical headless runs. The world is still a packed
`Float32Array` the host owns and `step` is still a pure function of it; what
changed is how little each step does around that packet. Measure with
`deno task bench:world` (Deno, then Chromium; add `--hardware --headed` for a
real GPU) and `deno run -A scripts/guest-loop-bench.ts`.

**Where 20,000 entities broke 16 ms.** The stress project (`scripts/stress`:
transform, mesh and body, 45 lanes and 3.6 MB per 20,000 entities; 4,000 of them
moving, which is `--movers 0.2`) before and after, in milliseconds, median with
the best run in brackets. Both were measured back to back with Blot2 86a527b on
a machine other agents kept at a load average of about 30 on 16 cores, so every
figure is inflated roughly twofold; quiet-machine runs of the guest call alone
gave 6 to 8 ms for 4,000 movers and 12 to 15 ms with all 20,000 moving.

| Per step, 20,000 entities            |    Before |     After |
| ------------------------------------ | --------: | --------: |
| Session step, 4,000 moving           | 28.8 (24) |  12.0 (9) |
| Session step, all moving             | 43.9 (35) | 28.1 (19) |
| Step, then `session.world`           |  129 (94) |   15 (10) |
| Step, `session.world`, extraction    | 255 (165) |   78 (65) |
| Outliner subscription                |       833 |    shared |
| Rollback state hash                  | 15.5 (14) | 1.7 (1.4) |
| One live edit while paused           | 380 (265) |   6.5 (5) |
| Rewind 45 ticks (4,000 moving)       |     3,742 |        81 |
| Editor in Chromium: step with panels |       845 |   20 (15) |
| Editor in Chromium: steps per second |       3.8 |      10.4 |

Inside the guest call, decode and encode took about 13.5 of 20 ms (20,000
entities, all moving, a quiet machine); the boundary copy is under 1 ms. Now
they take about 5.6. On the host `decodeWorld` (44 to 62 ms) and `extractScene`
(46 to 70 ms) each cost three steps, the outliner looked up every name with a
linear scan (quadratic overall), the rollback hash walked 3.7 MB a byte at a
time, and the timeline kept three minutes of full-size keyframes (660 MB at this
size). The Chromium rows are the editor with the outliner, inspector, timeline
and a game view mounted on an RTX 4080 SUPER; after the change its steps per
second are limited by the renderer, which spends about 130 ms of CPU submitting
20,000 draws on this loaded machine (46 ms on a quiet one).

**Decision: the world stays on the host.** The hill proposed keeping the decoded
world inside a JSPI-suspended `for ever` loop. `scripts/guest-loop-bench.ts`
measures it on 20,000 entities against the stateless step on the same machine:

| Moving | Stateless step | Loop median | Loop mean | Loop worst |
| -----: | -------------: | ----------: | --------: | ---------: |
|  2,000 |           13.2 |         1.1 |       4.9 |       22.3 |
|  4,000 |           14.9 |         3.1 |       8.9 |       29.5 |
| 20,000 |           20.4 |        54.6 |      53.7 |       73.5 |

The loop is cheaper on average while few entities change, because it skips
decode and encode. But every fourth backedge traces the whole object graph, so
one step in four takes 22 to 29 ms at this size, which misses a 16.7 ms frame;
and when everything moves it is two to three times slower, because allocation
after a collection is slower than the bump allocator a plain call gets. It also
needs JSPI, which Firefox and Safari lack, and a snapshot, hot reload or rewind
would still cross the boundary as a full packet. The stateless entry has none of
these costs and a flat worst case, so it stays; revisit it if Blot2's collector
gets incremental. Moving the cost out of the codec instead:

- The generated `encode_result` writes the result packet in place (one
  allocation, direct lane stores) instead of flattening per-entity chunks, and
  vectors decode as inline records.
- `decodeWorld` is lazy above 1,024 entities (see "The world model on the
  host"); a step that nobody inspects costs the host no decoding. `cloneWorld`,
  `encodeWorld` and `Session.edit` copy untouched entities verbatim.
- Keyframes are the immutable state arrays themselves; no copy is made. The
  timeline spaces them closer for big worlds (every 17 ticks at 20,000 entities,
  so rewinding replays under a quarter second of steps) and stops at a byte
  budget (256 MiB) rather than three minutes. Scrubbing forward continues the
  last replay. Undo history has the same byte budget.
- `Session.structure` is one object until an entity appears, moves or is
  renamed; the outliner renders only the rows in view and builds its tree
  linearly. `Session.entity(id)` is constant time.
- `advance` and the player stop catching up after 20 ms of stepping, so a world
  that cannot step in real time runs in slow motion instead of freezing the
  page. The rollback hash reads whole words.

**What is left.** The guest still decodes and encodes every entity each step
(about 5 ns per lane: 5 ms at 20,000 entities) plus the game's own systems; the
remaining way down is data the game does not touch (static scenery) staying out
of that pass, which needs a game-facing API (a prerequisite for physics' static
bodies). Extraction still builds a draw per entity and the renderer's cost per
draw (about 2 microseconds, 46 ms CPU for 20,000) is hill 10's culling and
instancing.

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

Terrain and scatter layers (`terrain` and `scatter` components, see
`docs/terrain.md`) keep their kilometre-scale data out of the world packet: a
heightfield and a placement list are assets (`*.terrain`, `*.scatter`) shared by
the renderer and the tools, edited in strokes whose revision the scene stores,
so undo and rewind move the data with the world. Game code sees only a coarse
height grid through `ink/terrain`.

Temporal anti-aliasing is per-view presentation state: previous camera and mesh
poses, jitter and color/depth history. It accepts an internal render scale while
keeping the canvas, UI and picking coordinates at their original size. Rewind,
camera cuts, resizing and asset replacement invalidate history; deterministic
still captures bypass it. The renderer's README describes the controls and
reconstruction limits.

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
