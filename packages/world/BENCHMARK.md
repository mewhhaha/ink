# @ink/world benchmark baseline

Run the package benchmark with:

```sh
pnpm --filter @ink/world bench
```

The pinned local baseline was recorded on 2026-08-05 with Deno 2.9.4 on Linux
x86-64 and an AMD Ryzen 7 7800X3D.

| Scenario                                         | Baseline mean | 10% limit |
| ------------------------------------------------ | ------------: | --------: |
| Demand over a 10,000-cell static partition       |        4.0 ms |    4.4 ms |
| Demand for a 100-cell moving-camera traversal    |      357.6 ms | 393.36 ms |
| Edit 1,000 terrain samples and rebuild one chunk |        4.3 ms |   4.73 ms |
| Reconcile 10,000 cells against a 64-cell budget  |        1.6 ms |   1.76 ms |

A repeatable mean over the limit on the same machine and runtime is a regression
unless the package plan explicitly records a new budget.
