# UI benchmark baseline

Recorded on 2026-08-05 with Deno 2.9.4 on an AMD Ryzen 7 7800X3D. These are
local development baselines, not portable performance guarantees.

| Scenario                                  |     Mean | Iterations per second |
| ----------------------------------------- | -------: | --------------------: |
| Layout 1,000 retained UI nodes            | 239.5 µs |                 4,176 |
| Project 1,000 nodes to headless semantics | 273.7 µs |                 3,654 |

Run `pnpm --filter @ink/ui bench` from the repository root to compare a change
on the same machine. Review both the mean and tail latency before accepting a
regression because browser adapters and scene projection add costs outside these
package-local measurements.

The default regression limit is the pinned mean plus 10%. Refresh a baseline
only when its implementation or fixture changes intentionally, on a recorded
runtime and machine.
