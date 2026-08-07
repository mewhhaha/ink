# @ink/ui plan

Status: implemented; consumer cutover is documented and pending.

## Purpose

Provide game-authored UI whose visual, input, and accessible representations
come from one semantic tree and remain usable without the renderer.

## Ownership

This package owns semantic nodes, native widget vocabulary, layout, focus and
reading order, directional navigation, HUD composition, localized message
references, announcements, game actions, HTML-in-canvas, overlay HTML, and
headless representations. It does not own editor panels, game rules, raw HTML
from guests, input devices, scene transforms, localization catalogs, text
layout, or WebGPU texture allocation.

## Planned contracts

- Stable semantic identities and a discriminated tree of regions, groups,
  buttons, text, images, progress, sliders, toggles, lists, text inputs, and
  status announcements.
- Layout values for flex, grid, absolute viewport placement, and scene
  attachment with explicit reading and focus order.
- Localized message references plus parameters; resolved text crosses only at
  the trusted host boundary.
- Normalized focus, activation, value-change, navigation, and text-edit actions.
- Browser HTML-in-canvas, overlay HTML, and JSON headless adapters consuming the
  same immutable snapshot.

## Dependencies and integration

Direct dependencies: `@ink/math`, `@ink/assets`, `@ink/scene`, `@ink/input`,
`@ink/runtime`, and `@ink/observability`.

Camera resolves scene and viewport placement; rendering may copy browser-painted
elements but does not own their semantics. Existing semantic protocol, React
surface, HTML-in-canvas adapter, and Blot HTML/flex blocks are extraction
inputs.

## Tasks

- [x] **UI-001:** Define the semantic tree, native widget states, stable
      identities, actions, announcements, reading order, and update revisions.
- [x] **UI-002:** Implement deterministic flex, grid, absolute, viewport, and
      scene-attached layout with player-scale and reduced-motion inputs.
- [x] **UI-003:** Implement focus retention, keyboard and directional
      navigation, pointer activation, text editing, disabled state, and modal
      focus containment.
- [x] **UI-004:** Consume `@ink/localization` resolvers for message references,
      preserve bidirectional direction, and leave shaping to browser adapters or
      `@ink/text`.
- [x] **UI-005:** Implement native overlay HTML, HTML-in-canvas, and headless
      adapters with equivalent semantics and normalized actions.
- [x] **UI-006:** Define the renderer texture-copy boundary and graceful
      fallback when HTML-in-canvas or WebGPU is unavailable.
- [x] **UI-007:** Provide current semantic-tree and flex migration contracts;
      consumer cutover occurs in development and guest adapters.
- [x] **UI-008:** Test focus across frames/reload, reading order, zoom and
      contrast, keyboard-only use, announcements, layout edges, text direction,
      scene attachment, and semantic-only operation.

## Operational requirements

- Malformed semantic trees, duplicate identities, invalid widget states, and
  failed localization resolution are rejected before replacing the last complete
  snapshot.
- HTML-in-canvas failure falls back to overlay HTML; graphics loss retains
  native and headless semantics. Missing optional visuals never remove meaning
  or actions.
- Focus changes, announcements, action dispatch, layout cost, capability loss,
  and adapter failures emit bounded observations without exposing private text
  input.
- Tree ordering, layout, focus navigation, and normalized actions are
  deterministic for the same snapshot, viewport, preferences, and input frame;
  browser text shaping is not.

## Acceptance

Meaningful actions and status never exist only as pixels. Stable identities
preserve focus across compatible frames and reload. Browser and headless
adapters expose the same roles, labels, state, order, and actions. Losing the
graphics device cannot make the semantic game unplayable.
