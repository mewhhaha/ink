# @ink/visual-effects benchmark

Run from this package with `deno task bench`.

The mixed fixture contains four emitters and capacities totaling 30,720
particles. The benchmarks isolate the costs that applications need when sizing a
visual-effects budget:

- one 60 Hz CPU reference step after population;
- reference alive-particle compaction;
- packing the 80-byte-per-particle GPU upload layout;
- render extraction with the conservative overdraw-area estimate; and
- building the bounded GPU buffer and dispatch plan at 75% quality.

These are CPU microbenchmarks. The GPU plan benchmark does not claim device
execution or GPU time. A device integration should record compute-pass timing
through `@ink/observability` and retain only the 16-byte diagnostics readback.
Compare results on the same Deno version and machine; absolute timings are not
portable.

The default regression limit is the pinned mean plus 10%. Refresh a baseline
only when its implementation or fixture changes intentionally, on a recorded
runtime and machine.
