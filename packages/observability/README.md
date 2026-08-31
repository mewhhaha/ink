# @ink/observability

`Observer` records game-neutral diagnostics, events, spans, metrics, and frame
profiles through an injected clock and `ObservationSink`. It does not read the
ambient clock or choose how records are displayed or exported.

Use `create_ring_buffer_sink` when records must remain available for inspection.
The buffer retains the configured number of newest records and reports how many
older records it evicted. Wrap any sink that leaves its originating subsystem
with `create_redacting_sink`; the default policy removes file paths, network
addresses, and game-authored text recursively.

`create_fan_out_sink` isolates a failing consumer and retains bounded failure
reasons. `export_observations` turns an asynchronous exporter failure into an
explicit result so diagnostics cannot change game execution.

`no_observations` is reserved for explicitly disabled collection, including the
disabled-path benchmark and deterministic tests that do not inspect telemetry.
Development applications should use the bounded, redacted log from
`@ink/development/debugger.ts` instead.

GPU timestamp ingestion remains experimental until the canonical renderer emits
real timings. It only converts timestamp pairs supplied by a renderer. An
unsupported device remains an explicit capability result; the package does not
fabricate GPU measurements.
