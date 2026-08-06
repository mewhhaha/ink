# Materials benchmark baseline

Recorded on 2026-08-05 with Deno 2.9.4 on an AMD Ryzen 7 7800X3D. These are
local development baselines and are not portable performance guarantees.

| Scenario                                         |   Mean | Iterations per second |
| ------------------------------------------------ | -----: | --------------------: |
| Create a canonical record (746 serialized bytes) | 8.1 µs |               122,900 |
| Update one retained material instance            | 7.8 µs |               128,900 |
| Import one metallic-roughness material           | 7.9 µs |               126,700 |
| Enumerate all 2,048 feature keys                 | 1.0 ms |                 960.3 |

Run `pnpm --filter @ink/materials bench` from the repository root to compare a
change on the same machine. GPU upload, pipeline selection, texture residency,
and shader cost are intentionally outside these renderer-independent results.

The default regression limit is the pinned mean plus 10%. Refresh a baseline
only when its implementation or fixture changes intentionally, on a recorded
runtime and machine.
