# @ink/runtime plan

Status: implemented; all consumers use the owning packages and the obsolete
`@ink/engine` package has been deleted.

## Purpose

Own the language-neutral game boundary and deterministic lifecycle that compose
replaceable engine capabilities in browser and headless hosts.

## Ownership

This package owns Wasm artifact loading, guest capabilities, block graphs,
lifecycle phases, fixed and variable frame scheduling, injected time and
randomness, snapshots, save/load, replay, hot reload, headless sessions, and
shutdown. It does not own a source language, ECS, rendering protocol, UI
vocabulary, asset interpretation, networking model, or editor interface.

## Planned contracts

- Parsed `GameArtifact`, `GameGuest`, `Capability`, `Block`, and `RuntimeGraph`
  values with stable identities and declared dependencies.
- Explicit initialize, start, fixed-step, frame, describe, snapshot, restore,
  reload, and close phases.
- `FrameContext` containing injected time, deterministic random state, frame
  identity, sequence, interpolation amount, and opaque registered deterministic
  channel payloads.
- Versioned snapshot envelopes and replays carrying artifact and schema digests,
  checksums, deterministic random state, and ordered channel payloads.
  Capability packages own the codecs and state inside their registered payloads.
- Browser and JSON Lines headless hosts implementing the same session contract.

## Dependencies and integration

Direct dependency: `@ink/observability`.

Capability packages bind to runtime without runtime importing their domain
types. Assets can supply Wasm bytes through an adapter. Blot-specific preview,
session, and JSON Lines vocabulary remains in `@ink/blot` rather than entering
the language-neutral runtime.

## Tasks

- [x] **RUNTIME-001:** Define artifact parsing, capability negotiation, graph
      construction, cycle diagnostics, phase ordering, and shutdown guarantees.
- [x] **RUNTIME-002:** Implement injected clocks, fixed-step accumulation,
      bounded catch-up, interpolation, pause, resume, stop, and explicit frame
      scheduling.
- [x] **RUNTIME-003:** Implement deterministic random streams, registered
      deterministic channels, versioned snapshot envelopes, checksums,
      save/load, replay, and trace correlation.
- [x] **RUNTIME-004:** Implement atomic hot reload: preserve compatible state,
      reset incompatible state with evidence, and retain the previous guest when
      loading the replacement fails.
- [x] **RUNTIME-005:** Implement browser and JSON Lines headless sessions with
      identical lifecycle and error results.
- [x] **RUNTIME-006:** Move language-neutral guest, protocol, save, replay,
      block, effect, and headless behavior from `@ink/engine`. The remaining
      preview ABI vocabulary is owned by the Blot adapter.
- [x] **RUNTIME-007:** Add lifecycle, graph-cycle, malformed-artifact,
      interrupted-reload, snapshot-corruption, replay-divergence, catch-up, and
      idempotent-close tests.
- [x] **RUNTIME-008:** Delete `@ink/engine` after Blot, development, and apps
      depend on the owning packages and all migration slices pass.

## Operational requirements

- Artifact, graph, phase, snapshot, and replay failures identify the guest,
  block, phase, and offending digest or sequence. Unhandled guest invariant
  violations stop that guest.
- Degradable capabilities may be absent only when declared optional; mandatory
  capability loss closes the session after releasing acquired resources.
- Every lifecycle transition, capability failure, reload decision, replay
  divergence, and frame-overrun policy emits structured observations.
- Frame ordering, registered channel payloads, random streams, snapshots, and
  replay are deterministic within the same engine and game build.

## Acceptance

A recorded run replays to the same snapshot checksum within the same engine and
game build. Failed hot reload cannot destroy the running guest. Every acquired
capability is released exactly once even when initialization or a later phase
fails. Browser and headless hosts agree on public observations for the same run.
