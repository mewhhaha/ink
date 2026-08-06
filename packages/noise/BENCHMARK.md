# @ink/noise benchmark

Run from this package with `deno task bench`.

The benchmark suite measures:

- 100,000 seeded four-coordinate hashes;
- 16,384 periodic 2D value, gradient, and cellular samples;
- 16,384 periodic five-octave fBm samples;
- 16,384 periodic three-octave domain-warp samples;
- a 256x256 four-channel interleaved texture bake; and
- concatenation of the five WGSL modules.

Sampling fixtures and allocations are intentionally stable. Compare results on
the same Deno version and machine. CPU timings do not claim GPU performance;
device integrations should separately compile the WGSL and profile their own
dispatch and resource upload path.

## Initial local baseline

On 2026-08-05, Deno 2.9.4 on Linux x86-64 with an AMD Ryzen 7 7800X3D reported:

| Fixture                                 |     Mean |
| --------------------------------------- | -------: |
| 100,000 hashes                          |   2.8 ms |
| 16,384 value samples                    |   3.9 ms |
| 16,384 gradient samples                 |   5.6 ms |
| 16,384 cellular samples                 |  30.5 ms |
| 16,384 five-octave fBm samples          |  37.9 ms |
| 16,384 three-octave domain-warp samples |  72.1 ms |
| 256x256 four-channel bake               | 181.0 ms |
| WGSL source assembly                    |   1.1 µs |

These values are orientation baselines, not portable pass/fail thresholds.
