# Architecture

Ink is a foundation for building a game engine from blocks. It supplies stable
boundaries, host capabilities, reusable WebAssembly components, and editor
tooling. It does not prescribe one renderer, entity model, physics library, or
source language.

The current vertical slices implement these boundaries with a minimal Blot game
and a separate isometric map specialization, while leaving the catalog
deliberately small.

## Current runtime slice

The guest exports one `step` function. Before calling it, the host installs the
active phase and state; the game reads them through `Phase.current` and
`State.current`. A start or frame phase may publish the next immutable state
through `State.commit`, while describe and render phases emit output without
mutating it. Input and frame time enter through separate `Events.next` and
`Time.delta_us` effects; semantic buttons and render commands leave through
their own host effects. The minimal game has one object and one attached native
button. The map template composes the same boundaries into an orthographic grid
with spatial tile controls and a seamless terrain surface.

The current logical graph contains clock, input, game, semantic, render, assets,
observability, save, and replay blocks. The asset block parses a bundled OBJ
mesh registry; each scene object selects a mesh identity and the renderer draws
depth-tested instances with model/view/projection uniforms and WGSL lighting.
Assets and render are degradable: if the model or WebGPU cannot start, the
semantic game remains playable. Dependencies are resolved and cycle checked
through `Program`, `Do`, and `State`.

Reusable Blot blocks live in the core `@ink/blot` package. It owns game-neutral
lifecycle, state, viewport, input, time, scene-object rendering, attached HTML
elements, math, geometry, sprite-atlas, tilemap, and flex capabilities. A game
directory owns its state transitions, rules, semantic composition, and render
composition.

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

Game-local Blot components use element statements such as `<Button … />` to
produce that tree. Element properties carry semantics, spatial attachment, and
presentation through ordinary typed records; the syntax introduces no separate
renderer or hidden effect path.

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

The game attaches each region to a generic scene object with a local offset and
plane size. `copyElementImageToTexture` writes each browser-rendered control
into its own WebGPU texture, and the renderer draws that texture on the attached
plane. The plane and its object share a model/view/projection transform, so they
move as one. `getElementTransform` applies that same transform to the native
element's hit testing. The host supplies only the structural layout needed for
this synchronization and leaves presentation open to engine, game, and player
styles. A low-vision presentation can therefore enlarge labels, strengthen
contrast, expose focus, or replace a spatial layout without changing game logic.

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
its build adapter. The example adapter watches the shared `@ink/blot` package
and the local game; the development surface polls the resulting artifact digest.
A matching schema digest restores the scalar guest state into the replacement
module; an incompatible schema starts again with a screen-reader announcement.
Unrelated development state survives.

Reload is a normal lifecycle transition, so it uses the same interfaces and
observation path as initial loading and shutdown. Language tooling remains
outside the runtime: Blot can use its resident compiler, while another language
can provide a different build adapter that produces the same Ink contract.

## Editors specialize without widening core

`@ink/development` remains the smallest generic canvas, semantic surface, and
transport composition. The isometric map application is a copyable template that
composes that surface with its own terrain, source language, and build
configuration. Genre-specific editor code stays local until multiple
applications need the same behavior.

The map slice proves a deliberately narrow boundary: a compact orthographic
grid, one terrain mesh, a seamless HTML-in-Canvas texture, named tile regions,
headless operation, and deterministic saves. The visual terrain is one map-level
semantic surface so independently clipped regions cannot introduce seams. Each
tile remains a separate transparent native element for assistive-technology
navigation without introducing builder behavior.

The review identified four foundations required before growing the map into a
large simulation:

- guest-owned structured snapshots once map state outgrows one scalar;
- a game-authored camera with pan, zoom, and shared projection math;
- pointer and wheel effects plus screen-to-world picking; and
- screen-space semantic placement for HUDs and menus.

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
