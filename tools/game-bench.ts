import { compile } from "../tests/support.ts";
import { measure, writeReport } from "./report.ts";

const started = performance.now();
const fixture = await compile(
  new URL("../tests/game_modules.blot", import.meta.url),
);
const compileMs = performance.now() - started;
try {
  const results = [];
  for (
    const [name, count] of [
      ["cull_workload", 10000],
      ["particle_workload", 10000],
      ["sprite_workload", 10000],
      ["bones_workload", 100],
      ["placement_workload", 123],
    ] as const
  ) {
    const result = measure(() => fixture.guest.call(name, count));
    let witness: unknown = result.witness;
    if (ArrayBuffer.isView(witness)) {
      witness = Array.from(witness as Float32Array);
    }
    results.push({ name, count, ...result, witness });
  }
  await writeReport("game", { compileAndInstantiateMs: compileMs, results });
} finally {
  await fixture.dispose();
}
