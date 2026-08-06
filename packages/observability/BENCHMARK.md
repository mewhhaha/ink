# @ink/observability benchmark baseline

Run the package benchmark with:

```sh
pnpm --filter @ink/observability bench
```

The pinned local baseline was recorded on 2026-08-05 with Deno 2.9.4 on Linux
x86-64 and an AMD Ryzen 7 7800X3D. The disabled event path averaged 29.7 ns and
the bounded event path averaged 94.3 ns. Their default 10% regression limits are
32.7 ns and 103.7 ns respectively.

Compare on the same machine and runtime. A repeatable result over either limit
requires investigation or an explicit baseline update in the package plan.
