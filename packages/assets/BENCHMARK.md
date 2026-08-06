# @ink/assets benchmark baseline

Run the package benchmark with:

```sh
pnpm --filter @ink/assets bench
```

The pinned local baseline was recorded on 2026-08-05 with Deno 2.9.4 on Linux
x86-64 and an AMD Ryzen 7 7800X3D. A repeatable mean more than 10% above the
limit is a regression unless the package plan records why the budget changed.

| Scenario                                       | Baseline mean | 10% limit |
| ---------------------------------------------- | ------------: | --------: |
| Lease acquisition and release                  |        1.7 µs |   1.87 µs |
| Parse 1,000 OBJ triangles                      |      518.5 µs |  570.4 µs |
| Publish 1,000 streamed assets                  |        1.8 ms |   1.98 ms |
| Replace a shared 100-asset revision            |      393.0 µs |  432.3 µs |
| Decode a small image through an injected codec |        4.2 µs |   4.62 µs |

Compare on the same machine and runtime; cross-machine results are diagnostic,
not grounds for changing the pinned limits.
