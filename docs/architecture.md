# Architecture

Ink is a foundation for building a game engine from blocks. It supplies stable
boundaries, host capabilities, reusable WebAssembly components, and editor
tooling. It does not prescribe one renderer, entity model, physics library, or
source language.

The current vertical slice implements these boundaries with one Blot game, while
leaving the catalog deliberately small.

## Current runtime slice

The guest exports five separate phases: `init`, `step`, `observe`,
`prepare_render`, and `render`. It owns an immutable signed-64-bit state value.
The host drives time and actions, captures semantic and render effects, and
publishes immutable observations. The initial scene has three spatial beacons
that can be focused and activated from pointer input, keyboard navigation, or
the headless API.

The current logical graph contains clock, input, game, semantic, render, assets,
observability, save, and replay blocks. The asset block parses a bundled OBJ
mesh; the render block uploads it once and draws depth-tested instances with
model/view/projection uniforms and WGSL lighting. Assets and render are
degradable: if the model or WebGPU cannot start, the semantic game remains
playable. Dependencies are resolved and cycle checked through `Program`, `Do`,
and `State`.

Reusable Blot blocks are ordinary imported modules. The Scene Explorer uses the
geometry block directly; math, sprite-atlas, and tilemap blocks establish the
same source-level component pattern for subsequent games.

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

Blot is a first-class language because its existing compiler emits Core
WebAssembly with an ABI manifest, represents host effects as typed imports, and
supports incremental compilation through a resident compiler. Ink should adapt
those artifacts to its runtime interfaces without making Blot-specific types the
universal engine contract.

Common functionality can ship as reusable WebAssembly components. A game may
compose those components, replace them with another implementation, or provide
its own. The host should contain only capabilities that must cross into the
desktop environment.

## Accessibility is a synchronized HTML surface

Ink pairs the canvas bitmap with real HTML representing the game's meaningful
regions and interactions. The HTML uses the canvas coordinate system but lives
in a positioned DOM layer over it. Canvas fallback descendants can receive
focus, but they are not rendered visually with the bitmap; an overlay lets the
same controls support screen readers, keyboard play, magnification, visible
focus, high-contrast themes, and game-authored styling.

The game does not send raw HTML. It exposes a structured semantic tree whose
nodes can describe:

- a stable identity and parent;
- reading and focus order;
- a region in game coordinates;
- a native element kind, accessible name, and description;
- state such as disabled, selected, checked, expanded, or a current value;
- available actions such as activate, edit, increment, or decrement; and
- intentional announcements for important state changes.

The host renders that tree with stable React keys. Stable identities preserve
focus across frames and compatible hot reloads. DOM order carries the meaningful
navigation order; visual coordinates never decide reading order. Native HTML
elements are preferred, with ARIA used only when HTML has no equivalent
semantic.

The host maps regions through the same viewport transform used by the renderer,
applies only the layout needed to align them with the canvas, and leaves their
presentation open to engine, game, and player styles. A low-vision presentation
can therefore enlarge labels, strengthen contrast, expose focus, or replace a
spatial layout without changing game logic.

Native focus, keyboard, pointer, and value-change events are normalized into
semantic game actions containing the stable region identity. Those actions cross
the same WebAssembly capability boundary as other input. Both the semantic tree
and its event stream are observable and testable, so an automated host can play
the meaningful game without reading pixels.

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

The development task watches Blot blocks and the example game, rebuilds the Wasm
artifact, and the editor polls its digest. A matching schema digest restores the
scalar guest state into the replacement module; an incompatible schema starts
again with a screen-reader announcement. Unrelated editor state survives.

Reload is a normal lifecycle transition, so it uses the same interfaces and
observation path as initial loading and shutdown. Language tooling remains
outside the runtime: Blot can use its resident compiler, while another language
can provide a different build adapter that produces the same Ink contract.

## Direction of dependency

The intended dependency direction is:

1. The desktop host owns operating-system and browser capabilities.
2. The Ink runtime loads blocks, connects their declared interfaces, observes
   them, and coordinates reloads.
3. Adapters translate block output into rendering, audio, accessibility, and
   other host effects.
4. Game modules depend only on the capabilities and reusable components they
   select.

The editor observes and controls this graph. It does not become part of the
game's logic.
