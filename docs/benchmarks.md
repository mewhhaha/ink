# Library measurements

## Measurement workflow

Run `pen tool ink -- bench`, optionally selecting workloads such as
`pen tool ink -- bench physics terrain`. The workload catalog is
`tools/native/workloads.json`; the report is `.cache/bench-library-native.json`.

Keep numerical witnesses, compiler/runner/source identities, workload sizes,
warmup and repeated samples. Separate compile time, warmed guest execution,
packet/presentation work, committed memory and host RSS. Do not infer
application speed from a small fixture or reuse older ownership counters as new
memory data. Run GPU witnesses headlessly and sequentially.

Developer benchmark tools stay outside the distributed source package; source
contracts are in [architecture](architecture.md) and [the library API](blot.md).
