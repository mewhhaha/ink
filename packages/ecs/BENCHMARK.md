# @ink/ecs benchmark baseline

Recorded 2026-08-05 on Deno 2.9.4 for Linux x86-64 with an AMD Ryzen 7 7800X3D.
Each fixture uses a 1,000-entity dynamic world and observations are disabled.

| Scenario                   |     Mean |
| -------------------------- | -------: |
| Allocate 1,000 entities    | 105.1 µs |
| Iterate 1,000 components   |  61.9 µs |
| Join 500 of 1,000 entities |  32.7 µs |
| Recycle 100 entities       |  25.3 µs |
| Snapshot 1,000 components  |  84.0 µs |
| Extract 100 changes        |   5.7 µs |

The single-component snapshot fixture serializes to 190,777 UTF-8 bytes. These
numbers establish the pre-specialization reference, not a cross-machine
performance promise. Investigate a reproducible regression above 10% using the
same runtime, CPU, and fixture before accepting a new baseline.
