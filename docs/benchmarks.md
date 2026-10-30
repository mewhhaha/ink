# Library measurements

Finish the correctness and integration milestones in
[the continuation notes](https://github.com/mewhhaha/ink/blob/main/CONTINUE.md)
before performance work. The owned-storage rewrite has no complete library or
Gdev qualification yet. Earlier snapshot/counting runtime timings do not measure
it.

## Measurement workflow

Run `pen tool ink -- bench`, optionally selecting workloads such as
`pen tool ink -- bench physics terrain`. The workload catalog is
`tools/native/workloads.json`; the report is `.cache/bench-library-native.json`.
These are continuation commands, not checks executed for this cleanup.

Keep numerical witnesses, compiler/runner/source identities, workload sizes,
warmup and repeated samples. Separate compile time, warmed guest execution,
packet/presentation work, committed memory and host RSS. Do not infer
application speed from a small fixture or reuse older ownership counters as new
memory data. Run GPU witnesses headlessly and sequentially.

The repository's `tools/audits/benchmark-history.md` preserves previous results,
candidate identities and methodology. Developer audit records stay outside the
distributed source package; source contracts are in
[architecture](architecture.md) and [the library API](blot.md).
