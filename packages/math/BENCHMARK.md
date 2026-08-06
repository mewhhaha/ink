# @ink/math benchmark baseline

The initial bulk affine-transform benchmark is run with:

```sh
pnpm --filter @ink/math bench
```

On 2026-08-05, Deno 2.9.4 on Linux x86-64 with an AMD Ryzen 7 7800X3D reported a
mean of 418.5 microseconds per 10,000 points. This measurement is a local
baseline with a 460.4 microsecond regression limit (baseline plus 10%). Compare
later changes on the same machine and runtime, and refresh the pinned value only
when the implementation or fixture changes intentionally.
