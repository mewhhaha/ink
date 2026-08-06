# @ink/scene benchmark baseline

Run the package benchmark with:

```sh
pnpm --filter @ink/scene bench
```

The pinned local baseline was recorded on 2026-08-05 with Deno 2.9.4 on Linux
x86-64 and an AMD Ryzen 7 7800X3D.

| Scenario                             | Baseline mean | 10% limit |
| ------------------------------------ | ------------: | --------: |
| Resolve a 10,000-node deep hierarchy |       44.8 ms |   49.3 ms |
| Apply 1,000 animated node deltas     |        7.3 ms |   8.03 ms |

A repeatable mean over the limit on the same machine and runtime is a regression
unless the package plan explicitly records a new budget.
