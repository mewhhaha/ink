import { createCompiler, instantiateGuest } from "@mewhhaha/blot";
import { libraryUrl } from "../mod.ts";
import { blotRoot } from "./setup.ts";
import { measure, writeReport } from "./report.ts";

const compiler = await createCompiler({
  entry: new URL("./compiler-probe.blot", import.meta.url),
  imports: { "ink/": libraryUrl },
  executable: new URL("zig-native/zig-out/bin/blotc", blotRoot),
  stdRoot: new URL("std/", blotRoot),
  prelude: new URL("std/prelude.blot", blotRoot),
});
try {
  const built = await compiler.build();
  if (!built.success) throw new Error(JSON.stringify(built.diagnostics));
  const results = [];
  for (
    const name of [
      "inline_writes",
      "break_writes",
      "pathfinding",
      "unsigned_sort",
    ]
  ) {
    const guest = await instantiateGuest(built.bytes);
    try {
      // Warm both sizes before sampling so a tier-up cannot skew the doubling ratio.
      for (let round = 0; round < 50; round++) {
        guest.call(name, 1000);
        guest.call(name, 2000);
      }
      const scales = [];
      for (const count of [1000, 2000]) {
        const result = measure(() => guest.call(name, count), 5, 15);
        const witness = result.witness;
        if (name.endsWith("writes")) {
          if (
            !(witness instanceof Float32Array) || witness[0] !== count - 1 ||
            witness[1] !== count * (count - 1) / 2
          ) {
            throw new Error(`${name} lost its last write`);
          }
        } else if (name === "pathfinding") {
          if (
            !(witness instanceof Float32Array) || witness[0] !== count - 1 ||
            witness[1] !== count || witness[2] !== count
          ) {
            throw new Error("Pathfinding witness changed");
          }
        } else if (
          !(witness instanceof Uint32Array) || witness[0] !== count - 1 ||
          witness[1] !== 0 || witness[2] !== count ||
          witness[3] !== count * (count * count - 1) / 6
        ) {
          throw new Error("Unsigned sorting witness changed");
        }
        let reportedWitness: unknown = witness;
        if (ArrayBuffer.isView(witness)) {
          reportedWitness = Array.from(witness as Float32Array);
        }
        scales.push({
          count,
          milliseconds: result.milliseconds,
          warmup: result.warmup,
          witness: reportedWitness,
        });
      }
      const ratio = scales[1].milliseconds.median /
        scales[0].milliseconds.median;
      let scaling = "subquadratic";
      if (ratio >= 3.4) {
        scaling =
          "possible quadratic copying; inspect this compiler/library change";
      }
      results.push({
        name,
        tierWarmupInterleavedRounds: 50,
        scales,
        doublingRatio: ratio,
        scaling,
      });
    } finally {
      guest.dispose();
    }
  }
  await writeReport("compiler-probe", {
    wasmBytes: built.bytes.length,
    note:
      "Timings diagnose scaling; only numerical witnesses fail this probe. break_writes is an intentional compiler reuse control.",
    results,
  });
} finally {
  await compiler.dispose();
}
