# Ray tracing benchmark baseline

Recorded on 2026-08-30 with Deno 2.9.5 on an AMD Ryzen 7 7800X3D. These are
local development baselines, not portable performance guarantees.

| Scenario                                         |   Mean | Iterations per second |
| ------------------------------------------------ | -----: | --------------------: |
| Pack 256 triangles into BLAS and TLAS arrays     | 1.6 ms |                 617.7 |
| Trace a nearest hit through 256 packed triangles | 7.2 µs |               139,800 |

Run `pnpm --filter @ink/ray-tracing bench` from the repository root to compare a
change on the same machine. GPU resource upload, compute dispatch, denoising,
presentation, and submission are owned by `@ink/rendering` and are intentionally
outside these package results.

Record a local baseline only after the input fixture or implementation changes;
cross-machine timings are not acceptance criteria.
