# Runtime benchmark baseline

Runtime: Deno 2.9.4 on AMD Ryzen 7 7800X3D. Recorded 2026-08-05 with
`pnpm --filter @ink/runtime bench`.

| Scenario                               | Mean baseline | Regression limit |
| -------------------------------------- | ------------: | ---------------: |
| Resolve 1,000 runtime blocks           |      500.5 us |         550.6 us |
| Capture a 4 KiB deterministic snapshot |       52.2 us |          57.4 us |

The regression limit is the pinned mean plus 10%. Refresh a baseline only after
the corresponding implementation or fixture changes intentionally, recording the
runtime and machine with the new result.
