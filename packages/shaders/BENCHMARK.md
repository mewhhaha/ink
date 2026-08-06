# Shaders benchmark baseline

Recorded on 2026-08-05 with Deno 2.9.4 on an AMD Ryzen 7 7800X3D.

| Scenario                            |   Mean | Iterations per second |
| ----------------------------------- | -----: | --------------------: |
| Compose all reusable WGSL modules   | 8.9 µs |               112,100 |
| Resolve a four-field shader variant | 1.2 µs |               832,500 |

Run `pnpm --filter @ink/shaders bench` from the repository root. The benchmark
measures deterministic CPU work only: composing the complete reusable module set
and resolving a representative typed variant. GPU compilation, pipeline
creation, driver caching, and device timing are renderer responsibilities and
intentionally excluded.

Treat a sustained regression above 10% on the same machine as a review trigger,
not as a portable performance guarantee. Refresh the baseline only when its
fixture or implementation changes intentionally.
