# @ink/observability plan

Status: implemented; runtime emits the contract and development exposes a
debugger sink adapter.

## Purpose

Make every engine boundary explainable without changing game behavior. The same
structured observations must serve the editor, headless tests, performance
investigation, and production diagnostics.

## Ownership

This package owns diagnostic records, lifecycle events, spans, counters,
histograms, frame timing, CPU/GPU profiling records, sampling, and sinks. It
does not own editor panels, console formatting policy, gameplay analytics,
network transport, clocks, or recovery behavior.

## Planned contracts

- Stable source and subsystem identities attached to every observation.
- Structured `Diagnostic`, `Event`, `Span`, `Metric`, and `FrameProfile`
  records.
- Injected clock and correlation context; observation never reads ambient time.
- Synchronous no-op and bounded-buffer sinks plus explicit async export edges.
- GPU timestamp ingestion that represents unsupported devices as capability
  absence rather than fabricated measurements.

## Dependencies and integration

Direct dependencies: none.

All effectful packages emit observations but do not choose their final
presentation. Existing game trace events and development debugger measurements
are migration inputs.

## Tasks

- [x] **OBS-001:** Define severity, subsystem identity, correlation, timestamp,
      duration, unit, and structured evidence conventions.
- [x] **OBS-002:** Implement no-op, fan-out, bounded ring-buffer, and test sinks
      with deterministic overflow accounting.
- [x] **OBS-003:** Implement nested CPU spans, counters, gauges, histograms, and
      frame profiles without relying on global mutable state.
- [x] **OBS-004:** Add WebGPU timestamp-query ingestion with an explicit
      unsupported result and delayed-frame correlation.
- [x] **OBS-005:** Define redaction at the sink boundary so network addresses,
      paths, and game-authored text are not exported accidentally.
- [x] **OBS-006:** Adapt runtime traces and development debugger views after the
      contract passes its conformance suite.
- [x] **OBS-007:** Measure disabled and enabled overhead and publish both in the
      package benchmark fixture.

## Operational requirements

- Invalid metric definitions and sink configuration fail before collection;
  exporter failures never alter game execution.
- Bounded sinks drop records only according to declared policy and expose
  dropped counts without recursively observing themselves.
- Record content and ordering are deterministic when supplied the same injected
  clock and correlation context; external export timing is not.

## Acceptance

Disabling observations does not change ordering, timing inputs, randomness, or
outputs of a deterministic run. Buffer overflow is counted rather than silently
lost. Every failure record contains the subsystem, operation, and offending
identity or value needed to investigate it.
