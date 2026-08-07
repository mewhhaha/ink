# @ink/timeline plan

Status: implemented.

## Purpose

Provide a renderer- and genre-neutral sequence document that specialized editors
can use to coordinate animation, cameras, audio, dialogue, effects, and gameplay
events on one clock.

## Ownership

This package owns timeline identities, bindings, scalar/vector/transform and
discrete tracks, referenced clip regions, event traversal, looping, validation,
and deterministic evaluation. It does not own animation clips, cameras, audio
voices, dialogue rules, editor panels, or clocks.

## Acceptance

- [x] Reject malformed tracks, duplicate identities, duplicate key times, and
      clips outside the timeline with evidence naming the offending track.
- [x] Evaluate continuous, discrete, and clip tracks at arbitrary playhead
      positions without mutating subsystem state.
- [x] Traverse events deterministically across forward, reverse, and looping
      playback.
- [x] Leave binding application to the specialized editor or application that
      composes the target subsystem.
