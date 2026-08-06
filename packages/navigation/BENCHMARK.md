# @ink/navigation benchmark baseline

Run the package benchmark with:

```sh
pnpm --filter @ink/navigation bench
```

The pinned local baseline was recorded on 2026-08-05 with Deno 2.9.4 on Linux
x86-64 and an AMD Ryzen 7 7800X3D.

| Scenario                                            | Baseline mean | 10% limit |
| --------------------------------------------------- | ------------: | --------: |
| Bake a 32-by-32 navigation tile                     |        2.1 ms |   2.31 ms |
| Rebuild one tile for a dynamic obstacle             |        2.9 ms |   3.19 ms |
| Account retained numeric storage for 1,024 polygons |       28.7 µs |  31.57 µs |
| Query a diagonal path across 1,024 polygons         |        2.0 ms |   2.20 ms |
| Repair a 63-polygon corridor                        |        2.0 ms |    2.2 ms |
| Update steering for 500 crowd agents                |        5.2 ms |   5.72 ms |

The storage benchmark covers deterministic numeric navigation structures, not
JavaScript runtime or string overhead. A repeatable mean over a time limit on
the same machine and runtime is a regression unless the package plan records a
new budget.
