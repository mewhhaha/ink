# Audio benchmark baseline

Runtime: Deno 2.9.4 on AMD Ryzen 7 7800X3D. Recorded 2026-08-05 with
`pnpm --filter @ink/audio bench`.

| Scenario                                           | Mean baseline | Regression limit |
| -------------------------------------------------- | ------------: | ---------------: |
| Schedule 128 active voices                         |       31.8 us |          35.0 us |
| Replace a 64-bus graph                             |      104.0 us |         114.4 us |
| Append 256 chunks and consume 16,384 stream frames |      494.8 us |         544.3 us |

The regression limit is the pinned mean plus 10%. Refresh a baseline only after
the corresponding implementation or benchmark fixture changes intentionally, and
record the runtime and machine with the new result. Stream snapshots report
latency, underruns, and retained bytes independently of wall-clock timing.
