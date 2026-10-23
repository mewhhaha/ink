/** Paired architectural experiments with identical work and checked witnesses. */
import { compile } from "../tests/support.ts";
import { checkWitness, sourceInventory, workloads } from "./library-bench.ts";
import { summary, writeReport } from "./report.ts";
const pairs = [
  ["navigation large_flow", "navigation-heap-flow"],
  ["render-cache-static_frames", "render-cache-static_uncached"],
  ["render-cache-sparse_frames", "render-cache-sparse_uncached"],
  ["render-cache-moving_frames", "render-cache-moving_uncached"],
  ["persist-words-codec_roundtrips", "persist-words-codec_bridge"],
  ["persist-words-roundtrip", "persist-words-bridge_roundtrip"],
  ["prepared-physics-workload", "prepared-physics-reference"],
  ["prepared-physics-walker_workload", "prepared-physics-walker_reference"],
  ["prepared-physics-joint_workload", "prepared-physics-joint_reference"],
  ["compiled-behavior-compiled", "compiled-behavior-interpreted"],
  ["pen-instances-retained", "pen-instances-immediate"],
];
const results = [];
for (const names of pairs) {
  const pair = names.map((name) => workloads.find((w) => w.name === name)!);
  const fixture = await compile(new URL(pair[0].fixture, import.meta.url), {
    "pen/": new URL("../tests/fixtures/pen/", import.meta.url),
  });
  try {
    const rows = [];
    for (const size of pair[1].sizes) {
      const samples: number[][] = [[], []], ratios: number[] = [];
      const witnesses: number[][] = [];
      for (let round = 0; round < 29; round++) {
        const elapsed = [0, 0];
        for (let turn = 0; turn < 2; turn++) {
          const at = (turn + round) % 2, start = performance.now();
          const result = fixture.guest.call(pair[at].entry, size);
          elapsed[at] = performance.now() - start;
          witnesses[at] = typeof result === "number"
            ? [result]
            : Array.from(result as Float32Array | Uint32Array);
          checkWitness(pair[at], size, witnesses[at]);
          if (round >= 20) samples[at].push(elapsed[at]);
        }
        // Codecs and packet encoders deliberately return differing wire lengths.
        if (
          !names[0].includes("codec_roundtrips") &&
          !names[0].startsWith("pen-") &&
          witnesses[0].join() !== witnesses[1].join()
        ) throw new Error(`Different semantics: ${names}`);
        if (round >= 20) ratios.push(elapsed[0] / elapsed[1]);
        if (fixture.guest.memoryBytes() > 512 * 1024 * 1024) {
          throw new Error("Experiment exceeded 512 MiB guest memory");
        }
      }
      rows.push({
        size,
        milliseconds: samples.map(summary),
        pairedRatio: summary(ratios),
        committedBytes: fixture.guest.memoryBytes(),
        witnesses,
      });
    }
    results.push({ names, rows });
  } finally {
    await fixture.dispose();
  }
}
await writeReport("levers", {
  timing:
    "20 warmup pairs and 9 measured pairs; alternate execution order; all setup included. Ratios are new/baseline. Pen timings measure guest encoding only, excluding host rendering.",
  sources: await sourceInventory(
    workloads.filter((w) => pairs.flat().includes(w.name)),
  ),
  results,
});
