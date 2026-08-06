# @ink/input benchmark baseline

Run the input baseline with:

```sh
pnpm --filter @ink/input bench
```

On 2026-08-05, Deno 2.9.4 on Linux x86-64 with an AMD Ryzen 7 7800X3D reported
these means:

| Scenario                               |               Mean |
| -------------------------------------- | -----------------: |
| Evaluate 64 digital actions            |  99.5 microseconds |
| Capture 1,000 normalized button events | 123.3 microseconds |

These measurements are local references rather than portable budgets. Compare
later changes on the same machine and runtime.

The default regression limit is the pinned mean plus 10%. Refresh a baseline
only when its implementation or fixture changes intentionally, on a recorded
runtime and machine.
