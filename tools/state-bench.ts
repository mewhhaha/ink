/** Paired state-mechanism comparisons; timings include fixture setup. */
import { createCompiler, instantiateGuest } from "@mewhhaha/blot";
import { libraryUrl } from "../mod.ts";
import { blotRoot } from "./setup.ts";
import { checkWitness, sourceInventory, workloads } from "./library-bench.ts";
import { summary, writeReport } from "./report.ts";

const pairs = [
  ["handles-lookup", "handles-dense-baseline"],
  ["handles-iteration", "handles-dense-baseline"],
  ["handles-churn-snapshots", "handles-dense-churn"],
  ["derived-staffing_cached", "derived-staffing_uncached"],
  ["codec-derived", "codec-handwritten-baseline"],
  ["behavior-actors", "behavior-reference"],
];
const results = [];
for (const names of pairs) {
  const pair = names.map((name) => {
    const workload = workloads.find((item) => item.name === name);
    if (!workload) throw new Error(`Missing workload: ${name}`);
    return workload;
  });
  const compiler = await createCompiler({
    entry: new URL(pair[0].fixture, import.meta.url),
    imports: { "ink/": libraryUrl },
    executable: new URL("zig-native/zig-out/bin/blotc", blotRoot),
    stdRoot: new URL("std/", blotRoot),
    prelude: new URL("std/prelude.blot", blotRoot),
  });
  try {
    const built = await compiler.build();
    if (!built.success) throw new Error(JSON.stringify(built.diagnostics));
    const guest = await instantiateGuest(built.bytes);
    try {
      const rows = [];
      for (const size of [64, 256, 1024]) {
        const samples: number[][] = [[], []];
        const pairedRatios: number[] = [];
        for (let round = 0; round < 29; round++) {
          const elapsed = [0, 0];
          for (let turn = 0; turn < 2; turn++) {
            const index = (round + turn) % 2;
            const start = performance.now();
            const witness = guest.call(pair[index].entry, size) as Uint32Array;
            elapsed[index] = performance.now() - start;
            checkWitness(pair[index], size, Array.from(witness));
            if (round >= 20) samples[index].push(elapsed[index]);
          }
          if (round >= 20) pairedRatios.push(elapsed[0] / elapsed[1]);
          if (guest.memoryBytes() > 256 * 1024 * 1024) {
            throw new Error("State benchmark exceeded 256MiB");
          }
        }
        rows.push({
          size,
          milliseconds: samples.map(summary),
          pairedRatio: summary(pairedRatios),
          committedBytes: guest.memoryBytes(),
        });
      }
      results.push({ names, rows });
    } finally {
      guest.dispose();
    }
  } finally {
    await compiler.dispose();
  }
}
await writeReport("state", {
  timing:
    "20 warmup pairs and 9 measured pairs; alternate execution order; fixture setup included; ratios are mechanism/baseline",
  sources: await sourceInventory(
    workloads.filter((workload) => pairs.flat().includes(workload.name)),
  ),
  results,
});
