# Procedural benchmark contract

Run with:

```sh
pnpm --filter @ink/procedural bench
```

Pinned on AMD Ryzen 7 7800X3D with Deno 2.9.4:

| Workload           | Fixture                                             |    Mean |
| ------------------ | --------------------------------------------------- | ------: |
| Heightfield baking | 256 × 256 analytical scalar field                   |  3.7 ms |
| Distance meshing   | 24 × 24 × 24 sphere field using marching tetrahedra | 29.7 ms |

A median runtime increase above 10% under the same Deno build and power profile
is a regression until explained and the baseline is intentionally repinned.
