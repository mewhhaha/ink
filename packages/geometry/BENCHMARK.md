# @ink/geometry benchmark baseline

Run the geometry baseline with:

```sh
pnpm --filter @ink/geometry bench
```

On 2026-08-05, Deno 2.9.4 on Linux x86-64 with an AMD Ryzen 7 7800X3D reported
these means:

| Scenario                                           |              Mean |
| -------------------------------------------------- | ----------------: |
| Query 10,000 rays against a 4,096-entry static BVH |       1.7 seconds |
| Build a static BVH with 4,096 bounds               | 53.1 milliseconds |
| Intersect 10,000 rays with one AABB                |  3.6 milliseconds |

These measurements are local references rather than portable budgets. Compare
later changes on the same machine and runtime.

The default regression limit is the pinned mean plus 10%. Refresh a baseline
only when its implementation or fixture changes intentionally, on a recorded
runtime and machine.
