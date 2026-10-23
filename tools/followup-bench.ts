/** Compare library storage changes with a supplied clean Ink checkout. */
import { createCompiler, instantiateGuest } from "@mewhhaha/blot";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { libraryUrl } from "../mod.ts";
import { blotRoot } from "./setup.ts";
import { summary, writeReport } from "./report.ts";
const baseline = Deno.args[0];
if (!baseline) {
  throw new Error("Supply the path to the previous clean Ink checkout");
}
const before = pathToFileURL(`${resolve(baseline)}/lib/`);
const results = [];
for (
  const [file, entries, sizes] of [
    ["ecs-history.blot", ["workload"], [1024, 8192, 65536]],
    ["ecs.blot", ["dense", "sparse", "churn"], [256, 1024, 4096]],
    ["render-cache.blot", ["static_frames", "sparse_frames", "moving_frames"], [
      256,
      1024,
      4096,
    ]],
  ] as const
) {
  const entry = new URL(`../tests/${file}`, import.meta.url);
  const current = await Deno.readTextFile(entry);
  // Adapt only the cache representation witness; the measured operations and
  // inputs stay identical. The new changes API has its own correctness tests.
  const previous = file === "render-cache.blot"
    ? current.split("entry const explicit_changes")[0]
      .replace('import * as changes from "ink/changes"\n', "")
      .replace("cache.read original 0", "original.draws[0]")
    : current;
  const fixtures = [];
  try {
    for (
      const [root, source] of [[before, previous], [
        libraryUrl,
        current,
      ]] as const
    ) {
      const compiler = await createCompiler({
        entry,
        imports: { "ink/": root },
        executable: new URL("zig-native/zig-out/bin/blotc", blotRoot),
        stdRoot: new URL("std/", blotRoot),
        prelude: new URL("std/prelude.blot", blotRoot),
      });
      const result = await compiler.build({
        sources: { [entry.pathname]: source },
      });
      if (!result.success) {
        await compiler.dispose();
        throw new Error(JSON.stringify(result.diagnostics));
      }
      fixtures.push({ compiler, guest: await instantiateGuest(result.bytes) });
    }
    for (const name of entries) {
      for (const size of sizes) {
        const samples: number[][] = [[], []], ratios: number[] = [];
        let witness: number[] = [];
        for (let round = 0; round < 29; round++) {
          const elapsed = [0, 0], values: number[][] = [[], []];
          for (let turn = 0; turn < 2; turn++) {
            const at = (turn + round) % 2, start = performance.now();
            values[at] = Array.from(
              fixtures[at].guest.call(name, size) as Float32Array | Uint32Array,
            );
            elapsed[at] = performance.now() - start;
            if (round >= 20) samples[at].push(elapsed[at]);
          }
          if (values[0].join() !== values[1].join()) {
            throw new Error(`Changed semantics: ${file} ${name} ${size}`);
          }
          witness = values[1];
          if (round >= 20) ratios.push(elapsed[1] / elapsed[0]);
        }
        results.push({
          file,
          entry: name,
          size,
          before: summary(samples[0]),
          after: summary(samples[1]),
          pairedRatio: summary(ratios),
          committedBytes: fixtures.map((f) => f.guest.memoryBytes()),
          witness,
        });
      }
    }
  } finally {
    for (const fixture of fixtures) {
      fixture.guest.dispose();
      await fixture.compiler.dispose();
    }
  }
}
await writeReport("followup", {
  baseline: resolve(baseline),
  timing:
    "Same compiler; 20 warmup and 9 measured alternating pairs; setup included.",
  results,
});
