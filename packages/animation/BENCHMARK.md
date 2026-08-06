# @ink/animation benchmark baseline

Recorded on 2026-08-05 with Deno 2.9.4 on an AMD Ryzen 7 7800X3D. Run
`pnpm --filter @ink/animation bench` against the same deterministic fixtures.

| Fixture                        |     Mean |
| ------------------------------ | -------: |
| Evaluate a 100-joint graph     |  14.5 µs |
| Blend two 100-joint poses      |  17.9 µs |
| Generate 100 skin matrices     | 195.3 µs |
| Compress 1,000 transform keys  |  87.3 µs |
| Evaluate a 128-character crowd |   1.8 ms |

These values are comparison baselines, not release budgets. Runtime, fixture,
algorithm, or hardware changes require a new baseline.

The default regression limit is the pinned mean plus 10%. Refresh a baseline
only when its implementation or fixture changes intentionally, on a recorded
runtime and machine.
