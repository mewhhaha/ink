# @ink/audio plan

Status: implemented.

## Purpose

Mix authored sound through an observable Web Audio implementation while keeping
audio optional and outside deterministic gameplay state.

## Ownership

This package owns audio device lifecycle, clips, streams, voices, emitters,
listeners, attenuation, spatialization, buses, sends, mixing, effects, voice
limits, pause, and device recovery. It does not own asset transport, scene
authority, gameplay timing, music rules, UI announcements, or operating-system
volume.

## Planned contracts

- Stable clip, stream, voice, emitter, listener, bus, and effect identities.
- Parsed play commands with an audio-local command sequence, injected monotonic
  presentation time, gain, pitch, loop, priority, fade, spatial settings,
  routing, and concurrency group. Application composition maps runtime frames to
  these presentation inputs.
- Immutable mix snapshots and ordered command batches.
- First-party bus graph, gain, panning, filtering, delay, convolution, dynamics,
  and metering over native Web Audio nodes.
- Explicit suspended, blocked, unavailable, interrupted, and recovered device
  states.

## Dependencies and integration

Direct dependencies: `@ink/math`, `@ink/assets`, `@ink/scene`, and
`@ink/observability`.

Camera supplies listeners; scene supplies emitter transforms; assets supply
decoded or streamed sources. Runtime records sound intent only when a game needs
replay diagnostics; audible output is not deterministic state.

## Tasks

- [x] **AUDIO-001:** Define device, voice, clip/stream, emitter/listener, bus,
      concurrency, command ordering, and degradation semantics.
- [x] **AUDIO-002:** Implement Web Audio device lifecycle, user-activation
      resume, suspension, interruption, output changes, and recovery.
- [x] **AUDIO-003:** Implement clip and stream playback, sample-accurate command
      scheduling by mapping presentation time once to the audio clock; define
      late one-shots, loop phase, pause, activation resume, fades, pitch,
      priorities, concurrency, and stealing.
- [x] **AUDIO-004:** Implement distance and cone attenuation, resolved panning,
      Doppler playback, and explicit coordinate conversion.
- [x] **AUDIO-005:** Implement buses, sends, gain, filters, delay, convolution,
      dynamics, metering, mix snapshots, and hot replacement.
- [x] **AUDIO-006:** Implement bounded voice/resource pools, pause behavior,
      origin rebasing, observations, and a no-audio backend.
- [x] **AUDIO-007:** Test activation blocking, scheduling, loop boundaries,
      stealing, routing, spatial math, interruption, unavailable devices,
      replacement, and cleanup.
- [x] **AUDIO-008:** Measure active voices, graph-update cost, stream buffering,
      latency, underruns, and memory.

## Operational requirements

- Invalid graphs, identities, routing, and scheduling values fail before native
  nodes are changed; native API failures include the operation and voice or bus
  identity.
- Blocked, suspended, interrupted, or unavailable audio selects the explicit
  no-audio state while retaining bounded sound intent and leaving gameplay
  active.
- Device state, voices, steals, underruns, late commands, bus levels, graph
  cost, and native failures emit bounded observations.
- Command ordering and voice selection are deterministic. Native decoding,
  audio-clock progress, spatial output, and audible samples are explicitly not
  replay state.

## Acceptance

Audio unavailability never blocks runtime or semantic UI. Voice stealing is
stable for identical priorities and commands. Stopping or replacing a sound
releases its native nodes and leases. Spatial tests agree with the shared
right-handed, Y-up convention after the explicit Web Audio conversion.

## Implementation

`model.ts` and `mixer.ts` own validated command ordering, one-time audio-clock
mapping, stable concurrency decisions, loop phase, and immutable snapshots.
`graph.ts` validates and hot-replaces the bus/effect graph before native nodes
are touched. `device.ts` contains the optional device lifecycle and Web Audio
adapter; constructing `AudioDevice` without an output is the explicit no-audio
backend. `spatial.ts` owns coordinate conversion and spatial acoustics, while
`stream.ts` provides bounded buffering with latency, underrun, and retained-byte
measurements.
