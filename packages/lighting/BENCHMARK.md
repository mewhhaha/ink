# Lighting benchmark baseline

Recorded on 2026-08-05 with Deno 2.9.4 on an AMD Ryzen 7 7800X3D. These are
local reference-planner baselines and are not portable performance guarantees.

| Scenario                                                |     Mean | Iterations per second |
| ------------------------------------------------------- | -------: | --------------------: |
| Evaluate 256 point-light assignments                    |  31.9 µs |                31,330 |
| Build 16×9×24 clusters for 256 lights                   |   1.5 ms |                 648.5 |
| Build a logical shadow plan for 16 point lights         |  15.4 µs |                65,110 |
| Select and blend 128 irradiance probes                  |  14.9 µs |                66,950 |
| Prefilter a 32×16 environment into six roughness levels | 415.0 µs |                 2,410 |

Run `pnpm --filter @ink/lighting bench` from the repository root to compare a
change on the same machine. GPU cluster upload, shadow rendering, environment
convolution, and final raster cost remain rendering-owned and are outside these
measurements.

The default regression limit is the pinned mean plus 10%. Refresh a baseline
only when its implementation or fixture changes intentionally, on a recorded
runtime and machine.
