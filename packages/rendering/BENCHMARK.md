# Rendering benchmark baseline

Runtime: Deno 2.9.4 on AMD Ryzen 7 7800X3D. Recorded 2026-08-05 with
`pnpm --filter @ink/rendering bench`.

| Scenario                             | Mean baseline | Regression limit |
| ------------------------------------ | ------------: | ---------------: |
| Compile 100-pass dependency graph    |      779.7 us |         857.7 us |
| Plan 10,000 clustered-forward draws  |        3.1 ms |           3.4 ms |
| Resolve 2,048 pipeline cache lookups |      187.0 us |         205.7 us |

The regression limit is the pinned mean plus 10%. Refresh baselines only when
the implementation or fixture changes intentionally. `RenderMetricHistory`
records extraction, submission, GPU time when available, allocations, uploads,
texture pressure, pipeline misses, shadow cache behavior, and rejected work.
