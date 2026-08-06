# @ink/visibility benchmark baseline

Run the package benchmark with:

```sh
pnpm --filter @ink/visibility bench
```

The pinned local baseline was recorded on 2026-08-05 with Deno 2.9.4 on Linux
x86-64 and an AMD Ryzen 7 7800X3D.

| Fixture     | Baseline mean | 10% limit |
| ----------- | ------------: | --------: |
| Sparse      |      405.4 µs |  446.0 µs |
| Dense       |       41.7 ms |   45.9 ms |
| Indoor      |        6.1 ms |   6.71 ms |
| Terrain     |        4.8 ms |   5.28 ms |
| High motion |        8.0 ms |    8.8 ms |

A repeatable mean over the limit on the same machine and runtime is a regression
unless the package plan explicitly records a new budget.
