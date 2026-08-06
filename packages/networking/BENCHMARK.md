# @ink/networking benchmark baseline

Recorded 2026-08-05 with Deno 2.9.4 on an AMD Ryzen 7 7800X3D.

| Fixture                         |     Mean |
| ------------------------------- | -------: |
| Encode 100-value packet         |   1.3 µs |
| Build 1,000-entity snapshot     | 683.9 µs |
| Simulate 1,000 impaired packets |   1.1 ms |

The default regression limit is the pinned mean plus 10%. Refresh a baseline
only when its implementation or fixture changes intentionally, on a recorded
runtime and machine.
