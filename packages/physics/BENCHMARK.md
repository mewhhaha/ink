# @ink/physics benchmark baseline

Recorded on 2026-08-05 with Deno 2.9.4 on an AMD Ryzen 7 7800X3D. Run
`pnpm --filter @ink/physics bench` to compare the same deterministic fixtures.

| Fixture                                                     |     Mean |
| ----------------------------------------------------------- | -------: |
| Dynamic-tree broadphase and persistent pairs, 256 colliders | 461.0 µs |
| GJK narrowphase, 1,000 overlapping box pairs                |   2.8 ms |
| Sequential solver, 32-body stack                            | 549.1 µs |
| Ordered ray query, 512 colliders                            | 363.7 µs |
| Sleeping-world fixed step, 256 bodies                       | 403.3 µs |
| Snapshot, 512 static colliders                              | 155.6 µs |

The 512-collider snapshot fixture encodes to 420,409 UTF-8 JSON bytes. Timing
and size are comparison baselines, not release budgets; changes to fixtures,
snapshot format, runtime, or hardware require a new baseline.

The default regression limit is the pinned mean plus 10%. Refresh a baseline
only when its implementation or fixture changes intentionally, on a recorded
runtime and machine.
