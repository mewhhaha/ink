# @ink/camera benchmark baseline

Run the package benchmark with:

```sh
pnpm --filter @ink/camera bench
```

The pinned local baseline was recorded on 2026-08-05 with Deno 2.9.4 on Linux
x86-64 and an AMD Ryzen 7 7800X3D.

| Scenario                     | Baseline mean | 10% limit |
| ---------------------------- | ------------: | --------: |
| Build 1,000 jittered views   |        7.3 ms |   8.03 ms |
| Construct 10,000 screen rays |       45.1 ms |   49.6 ms |

A repeatable mean over the limit on the same machine and runtime is a regression
unless the package plan explicitly records a new budget.
