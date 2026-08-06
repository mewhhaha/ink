# @ink/input plan

Status: implemented; development consumer cutover is documented and pending.

## Purpose

Convert platform device activity into stable, rebindable game actions that can
be saved, replayed, tested, and transported without reconstructing browser
events.

## Ownership

This package owns keyboard, pointer, touch, gamepad, and XR device snapshots;
focus and pointer-lock state; action maps; bindings; chords; dead zones;
rebinding; and deterministic input frames. It does not own UI semantics, camera
behavior, character movement, runtime scheduling, or network prediction.

## Planned contracts

- Normalized device identities, controls, button phases, axes, pointer
  positions, deltas, contacts, and connection lifecycle.
- Typed digital, scalar, and two-dimensional actions.
- Contextual action maps with explicit priority, consumption, chords,
  composites, dead zones, curves, and user bindings.
- Immutable `InputFrame` values keyed by runtime `FrameId` and registered as a
  deterministic runtime channel.
- Browser event adapter and synthetic headless adapter with identical output.

## Dependencies and integration

Direct dependencies: `@ink/math`, `@ink/runtime`, and `@ink/observability`.

Runtime supplies frame boundaries and records normalized frames. Camera, UI, and
games interpret actions. Networking transports action frames but does not depend
on browser event types. Existing pointer, wheel, semantic activation, and frame
actions are migration inputs.

## Tasks

- [x] **INPUT-001:** Define normalized device/control identities, action value
      types, frame phases, focus loss, connection, and ordering semantics.
- [x] **INPUT-002:** Implement action-map evaluation, contexts, composites,
      chords, consumption, dead zones, response curves, and rebinding.
- [x] **INPUT-003:** Implement browser keyboard, pointer, touch, gamepad, and XR
      adapters with explicit feature availability.
- [x] **INPUT-004:** Implement synthetic and recorded adapters for headless
      tests, replay, and networking.
- [x] **INPUT-005:** Define accessible rebinding conflicts and stable
      serialization for player settings.
- [x] **INPUT-006:** Provide the normalized pointer/zoom migration contract and
      document the development consumer cutover, which occurs after camera and
      UI adapters exist.
- [x] **INPUT-007:** Test press/hold/release, focus loss, simultaneous devices,
      hot-plug, chords, opposing axes, touch cancellation, and replay equality.

## Operational requirements

- Malformed bindings and unsupported controls return typed failures with the
  device and binding identity; malformed platform events are rejected at the
  adapter.
- Unavailable or disconnected devices contribute neutral controls and explicit
  lifecycle events rather than guessed input.
- Connection, focus, context, rebind conflict, consumed action, and adapter
  failures emit bounded observations without recording text input by default.
- Normalization and action evaluation are deterministic per runtime frame;
  native event arrival before frame capture is the explicit platform boundary.

## Acceptance

A browser event is normalized once and never escapes the package. Losing focus
releases held controls in a deterministic frame. Recorded and synthetic input
produce byte-equivalent action frames for the same declared device sequence.
