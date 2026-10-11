import { toolchain } from "./toolchain.ts";

function midpoint(sorted: number[]) {
  const middle = Math.floor(sorted.length / 2);
  let result = sorted[middle];
  if (sorted.length % 2 === 0) result = (sorted[middle - 1] + result) / 2;
  return result;
}

export function summary(values: number[]) {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("Benchmark samples must be finite and nonempty");
  }
  const sorted = values.toSorted((a, b) => a - b);
  const median = midpoint(sorted);
  const deviations = values.map((value) => Math.abs(value - median)).sort((
    a,
    b,
  ) => a - b);
  return {
    median,
    min: sorted[0],
    max: sorted.at(-1)!,
    medianAbsoluteDeviation: midpoint(deviations),
    samples: values.length,
  };
}

export function measure<T>(run: () => T, warmup = 5, rounds = 10) {
  for (let i = 0; i < warmup; i++) run();
  const samples: number[] = [];
  let witness: T | undefined;
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    witness = run();
    samples.push(performance.now() - started);
  }
  return { milliseconds: summary(samples), warmup, witness };
}

export async function writeReport(
  name: string,
  payload: Record<string, unknown>,
) {
  const report = {
    schemaVersion: 1,
    benchmark: name,
    recordedAt: new Date().toISOString(),
    toolchain: toolchain(),
    ...payload,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const cache = new URL("../.cache/", import.meta.url);
  await Deno.mkdir(cache, { recursive: true });
  await Deno.writeTextFile(new URL(`bench-${name}.json`, cache), json);
  console.log(json.trimEnd());
  return report;
}
