# Shader graph benchmark baseline

Recorded on 2026-08-05 with Deno 2.9.4 on an AMD Ryzen 7 7800X3D.

| Scenario                                 |    Mean | Iterations per second |
| ---------------------------------------- | ------: | --------------------: |
| Compile and fold a 199-node shader graph | 59.0 µs |                16,960 |

Run `pnpm --filter @ink/shader-graph bench` from the repository root. The
fixture validates and compiles a 199-node arithmetic graph whose reachable
operations fold to one constant expression. It measures deterministic graph and
source-generation CPU cost, not native WGSL compilation or GPU execution.

A sustained regression above 10% on the same machine is a review trigger.
Refresh the baseline only when its fixture or implementation changes
intentionally. Editor layout, serialization I/O, renderer pipeline creation, and
driver behavior are outside this package benchmark.
