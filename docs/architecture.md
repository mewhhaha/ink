# Architecture

Ink is a foundation for building a game engine from blocks. It supplies stable
boundaries, host capabilities, reusable WebAssembly components, and editor
tooling. It does not prescribe one renderer, entity model, physics library, or
source language.

The current vertical slices implement these boundaries with a minimal Blot game,
a compact first-person Doom arena, and a separate isometric map specialization,
while leaving the catalog deliberately small.

## Current runtime slice

The guest is a module computation exported as `default`. Before invoking it, the
host installs the active phase and state; the game reads its scalar state
through `State.current` and its indexed state through `Cells`. A start or frame
phase may publish the next immutable state, while describe and render phases
emit output without mutating it. Input and frame time enter through separate
`Events.next` and `Time.delta_us` effects; semantic buttons and render commands
leave through their own host effects. The minimal game has one object and one
attached native button. The map template composes the same boundaries into a
thirty-two by thirty-two orthographic grid with grass, sand, a connected road
graph, spatial districts, game-authored building actions, core render metrics,
and a movable host debugger.

The current logical graph contains clock, input, game, semantic, render, assets,
observability, save, and replay blocks. The asset block parses a bundled OBJ
mesh registry; each scene object selects a mesh identity and the renderer draws
depth-tested instances with model/view/projection uniforms and WGSL lighting.
Assets and render are degradable: if the model or WebGPU cannot start, the
semantic game remains playable. Dependencies are resolved and cycle checked
through `Program`, `Do`, and `State`.

Reusable Blot blocks live in the core `@ink/blot` package. It owns game-neutral
lifecycle, state, viewport, input, time, scene-object rendering, attached HTML
elements, ECS, math, geometry, sprite-atlas, tilemap, and flex capabilities. A
game directory owns its state transitions, rules, semantic composition, and
render composition.

The ECS block keeps its world in the guest snapshot rather than in an editor or
renderer. Entity handles include a generation, component columns are keyed by
entity and generation-tagged, and each component maintains dense and sparse
membership indexes. Inserting, removing, and checking a component are
constant-time. A recycled entity reuses its sparse slot, while generation checks
prevent a component from leaking across the reuse. Components declare their one
to eight `Int`, `Bool`, or sealed scalar fields once. Named `Ecs.system` values
declare component and resource accesses. `Ecs.add_system` composes them into an
immutable world builder, and `Ecs.build` folds that builder at compile time to
derive its complete schema, stores, resources, and joins. This lets a specialized
editor be an ordinary function from one world builder to another. A bare
component or resource grants writes; `Ecs.read`
narrows it to reads. The resulting scopes are fields such as `City.game` and
`City.rendering`, so opening one makes `Terrain`, `Residence`, and the other
permitted capabilities available without a registration list, store preamble,
scope bind, field aliases, or query registry. Read scopes do not contain mutation
operations. A missing payload field, unknown component, or unknown column is
rejected while the generated Wasm still uses fixed numeric slots.

Resources are typed singleton records in the same snapshot. Their defaults are
part of the schema digest and are installed before the start phase, so editor
selection, clocks, cursors, and aggregate statistics do not occupy artificial
entities. A resource exposes whole-record reads and transformations plus named
field reads and writes. Like component accesses, resource accesses are declared
by systems and contribute to world registration.

`Ecs.entities.dynamic` allocates and recycles generational handles.
`Ecs.entities.fixed` gives every index in its fixed domain a stable entity
identity, which avoids a parallel lookup table for grids, board cells, and
similar spaces. Entity identity is a world policy independent of the attached
systems; both policies use the same inferred components, resources, stores, and
query operations.

World, component, and resource descriptors are registered together during the
schema phase. Their layout is part of the hot-reload schema digest, so changing a
state layout starts a clean world while a logic-only rebuild restores all
entities, components, and resources. Indexed component seeds are registered with
the same schema, copied
into a fresh world before the game starts, and included in the digest so an
authored-data change deliberately creates a new world. Small seeds accept typed
component payloads; large generated maps use the explicit `seed_source` asset
boundary so compiling a game does not specialize thousands of terrain rows.
Components expose typed whole-value insertion, replacement, transformation and
reads, plus named field handles for focused updates and renderer columns. Reads
and dynamic spawns take explicit `some` and `none` branches, so no invalid entity
or component sentinel can escape an effectful Wasm boundary. Mutations and
membership checks return `Bool`. Field handles remain available under `.fields`
when a game field intentionally shares a name with an ECS operation. A scoped
component constructs its local query with `Component.query ()`; a multi-component
system exposes its ordered query as `City.system.entities`. Both preserve
read/write intent as future scheduling metadata and require no global query
registry. `visit` runs an update for a supplied entity. `visit_at` addresses the
dense index of the first query component, so
sparse component sets can be iterated without scanning the world's capacity;
putting the rarest component
first minimizes rejected joins. A candidate span may retain a recycled index,
but `visit_at` rejects it through the same generation check and insertion reuses
the slot rather than growing the span. Systems are ordinary Blot functions
composed in visible source order; queries own membership filtering rather than a
second system wrapper. The current Wasm backend cannot yet lower an effectful
residual recursive fold, so core exposes the dense cursor instead of hiding a
whole-world loop in the TypeScript host or unrolling the world's capacity into
the game module.

The scene block represents local position, three-axis rotation, three-axis
scale, material color, emissive intensity, parent identity, and visibility.
Parents are resolved into world transforms by the host; visibility is inherited
through the same hierarchy. The scalar and vector blocks provide deterministic
fixed-point operations so gameplay and scene construction do not depend on a
host floating-point math library.

## Blocks are the unit of composition

A block has an explicit interface and one responsibility. A game can select,
replace, or omit blocks for rendering, input, assets, audio, physics, storage,
accessibility, and other capabilities. Blocks compose through declared inputs
and outputs instead of ambient access to the host.

A useful block is:

- **replaceable:** consumers depend on its interface, not its implementation;
- **portable:** its contract does not assume the language that produced it;
- **observable:** its lifecycle, failures, and relevant measurements are visible
  to the editor;
- **reloadable:** the host can replace it without restarting unrelated blocks;
- **accessible:** visual output is never the only representation of meaningful
  game state or available actions.

These properties belong at the boundary. They should not require every game or
component author to rebuild editor integration from scratch.

## Host logic is composed, not orchestrated ad hoc

Functions owned by Ink use `snake_case`. External APIs retain their published
names at the boundary.

Host-side logic composes through `@mewhhaha/typeclasses`: use `Do` for a
sequence within one typeclass dictionary and `Program` when assembling effects
for an interpreter boundary. Pure leaf functions and framework callbacks remain
ordinary functions; effects move into local capabilities as the host grows.

## WebAssembly is the game boundary

Game logic runs as WebAssembly. Ink defines language-independent interfaces at
that boundary and grants host capabilities explicitly. Any language that can
produce a compatible module or component can be used.

Blot is a first-class toolchain because its compiler emits Core WebAssembly with
an ABI manifest and represents host effects as typed imports. `@ink/blot` adapts
those artifacts to `GameGuest`; neither the engine nor the reusable development
package depends on Blot types. Another app can use a different source language
by implementing the same contract.

Common functionality can ship as reusable WebAssembly components. A game may
compose those components, replace them with another implementation, or provide
its own. The host should contain only capabilities that must cross into its
environment.

## Accessibility is a synchronized HTML surface

Ink pairs the canvas bitmap with real HTML representing the game's meaningful
regions and interactions. The canvas opts into Chrome's experimental
HTML-in-Canvas layout, and each native control is a direct canvas child. The
browser lays out and paints those controls into the WebGPU texture while they
remain available to screen readers, keyboard play, magnification, visible focus,
high-contrast themes, and game-authored styling.

The game does not send raw HTML. It exposes a structured semantic tree whose
nodes can describe:

- a stable identity and attached scene object;
- reading and focus order;
- a region in game coordinates;
- a native element kind, accessible name, and description;
- button state or a progress value;
- focus and activation actions for interactive elements; and
- intentional announcements for important state changes.

Game-local Blot components sequence element expressions such as
`_ <- <Button … />;` to produce that tree. Element properties carry semantics,
spatial attachment, and presentation through ordinary typed records; the syntax
introduces no separate renderer or hidden effect path.

The current native element vocabulary is deliberately concrete: button, text,
and progress. Each maps to its matching browser element instead of emulating
semantics with generic containers. New element kinds belong in the shared ABI
only when the guest, protocol, browser adapter, headless observation, and tests
can all support their behavior end to end.

The host renders that tree with stable React keys. Stable identities preserve
focus across frames and compatible hot reloads. DOM order carries the meaningful
navigation order; visual coordinates never decide reading order. Native HTML
elements are preferred, with ARIA used only when HTML has no equivalent
semantic.

The game attaches each region either to a generic scene object with a local
offset and plane size or to a viewport corner with a pixel inset.
`copyElementImageToTexture` writes each browser-rendered control into its own
WebGPU texture, and the renderer draws that texture on the corresponding plane.
A scene plane and its object share a model/view/projection transform, so they
move as one; a viewport plane remains fixed while the world changes.
`getElementTransform` applies the same transform to the native element's hit
testing. The host supplies only the structural layout needed for this
synchronization and leaves presentation open to engine, game, and player styles.
A low-vision presentation can therefore enlarge labels, strengthen contrast,
expose focus, or replace a spatial layout without changing game logic.

Native focus, keyboard, and activation events are normalized into semantic game
actions containing the target supplied with the region. The guest reads those
actions through `Events.next`; it never reconstructs an event from a DOM
identifier. Both the semantic tree and its event stream are observable and
testable, so an automated host can play the meaningful game without reading
pixels.

Accessibility information follows the same state transition as visual output. It
is game output, not manually maintained duplicate UI. Individual games decide
what is meaningful; Ink supplies the interface, HTML adapter, event routing, and
accessible defaults.

## Observability is part of every boundary

The editor needs to explain what the running game is doing. Block lifecycle
events, capability calls, timing, diagnostics, and failures should carry block
identity and flow through a shared observation interface. The same information
can support an editor panel, automated tests, performance investigation, or a
headless host.

Observation must not change game behavior. Clocks, randomness, input, and other
effects remain explicit capabilities so runs can be inspected or reproduced
without hidden ambient state.

## Hot reload replaces the smallest valid graph

The Ink Vite plugin watches source directories supplied by the app and invokes
its build adapter only for Blot changes. The example adapter watches the shared
`@ink/blot` package and the local game; the development surface subscribes to
the `ink:game-updated` channel and loads the resulting artifact. A matching
schema digest restores the complete guest snapshot, including indexed cells,
into the replacement module; an incompatible schema starts again with a
screen-reader announcement. Resource changes copy one asset into the public
directory and replace renderer assets without compiling Wasm. Unrelated
development state, including debugger history and position, survives.

The browser runtime is mounted through one reusable React root. Application
entry modules accept their own Vite updates and render new editor or debugger
properties into that root. Re-evaluating an entry module, recreating an asset
descriptor, or replacing an artifact loader therefore does not recreate the
headless session, canvas, WebGPU device, renderer, or resource caches. Changing
the artifact URLs is an explicit runtime replacement and remains the only
property update that restarts those objects.

Blot builds serialize through a filesystem lock and publish the Wasm and
manifest through pending files. The client is not notified until both public
files have been replaced, so overlapping watcher events cannot delete another
build's transient output or announce a partial artifact.

Reload is a normal lifecycle transition, so it uses the same interfaces and
observation path as initial loading and shutdown. Language tooling remains
outside the runtime: Blot's generated parser and final emitter run as
WebAssembly without a resident service or GPU adapter, while another language
can provide a different build adapter that produces the same Ink contract.

## Editors specialize without widening core

`@ink/development` remains the smallest generic canvas, semantic surface, and
transport composition. The isometric map application is a copyable template that
composes that surface with its own terrain, source language, and build
configuration. Genre-specific editor code stays local until multiple
applications need the same behavior.

The map slice proves a deliberately narrow boundary: a compact orthographic
grid, tileable terrain materials, connectable road geometry, named tile regions,
headless operation, deterministic saves, and a game-authored settlement slice.
Immigrants enter through a map opening, claim housing plots, and build tents;
water coverage upgrades tents, while fire risk and a moving marshal create the
first service loop. Units interpolate between tile centers every frame and
choose among all eight neighboring tiles with a strong but bounded preference
for paths. Pointer projection and the construction palette stay in the isometric
application; the resulting action is processed and saved by the Wasm game.

UI ownership follows the same dependency direction. Core development owns
transport controls and produces generic measurements and debugger operations.
The game publishes meaningful actions, semantic regions, and state; it does not
choose the editor's panel layout. A specialized editor presents those actions as
a palette and chooses where metrics or debugging tools appear. Headless and
agent hosts can consume the same published actions without rendering that
palette.

The map uses an indexed ECS world with one stable entity per tile and fixed unit
entities. Components own terrain, construction, residences, water coverage, unit
movement, and presence. Resources own editor selection, simulation timing,
cursors, population, and fire counts without manufacturing an entity for
singleton state. Rendering reads
registered component views: terrain requires one component on every tile, while
generic isometric component layers match construction and unit values and may
derive cardinal connections. No core renderer assigns genre meaning to a
component value. ECS state passes through save, load, replay, headless
execution, and compatible hot reload without an editor-side mirror. Two
foundations remain before growing the map into a large simulation:

- a game-authored camera with pan, zoom, and shared projection math beyond the
  template's fixed isometric picking;
- a structured action vocabulary for scalable accessible tile navigation.

Batching and culling should follow measured scene scale. These gaps stay
explicit rather than being hidden in genre-specific host code.

## Direction of dependency

The current dependency direction is:

1. The browser host owns platform capabilities.
2. The Ink engine loads blocks, connects their declared interfaces, observes
   them, and coordinates reloads.
3. Adapters translate block output into rendering, audio, accessibility, and
   other host effects.
4. Game modules depend only on the capabilities and reusable components they
   select.

The development app observes and controls this graph. It does not become part of
the game's logic.
