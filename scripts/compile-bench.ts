/**
 * How long Blot builds take as a game grows: cold, then incremental edits of
 * a number in the entry module, for an example project padded with generated
 * systems (each maps over the entities and moves one component). Run it to see
 * where blotc's incremental build stops being "under 100 ms" and to hand
 * upstream concrete sizes.
 *
 *   deno run -A scripts/compile-bench.ts [example] [--sizes=0,100,400]
 *                                        [--edits=8]
 */
import { join } from "@std/path";
import { createGameCompiler } from "@ink/blot/compiler";
import { scanAssets } from "@ink/dev/catalog";
import { percentile } from "@ink/core";

const args = Deno.args.filter((a) => !a.startsWith("--"));
const option = (name: string, fallback: string) =>
  Deno.args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const example = args[0] ?? "hammer";
const sizes = option("sizes", "0,100,400").split(",").map(Number);
const edits = Number(option("edits", "8"));

function system(i: number) {
  return `const sys_${i} = fn (input: s.Input) => fn (e: s.Entity) => do:
  let #Some t = e.transform else:
    return e
  t.position.y := self + 0.0001 * ${i}.0 * input.dt
  e.transform := #Some t
  return e
`;
}

const root = new URL("../", import.meta.url).pathname;
for (const count of sizes) {
  const dir = await Deno.makeTempDir({ dir: join(root, "tmp"), prefix: "cb-" });
  const game = join(dir, "game");
  await Deno.mkdir(game, { recursive: true });
  const schema = (await import(join(root, "examples", example, "schema.ts")))
    .default;
  const catalog = await scanAssets(join(root, "examples", example, "assets"));
  let main = await Deno.readTextFile(
    join(root, "examples", example, "game/main.blot"),
  );
  if (count > 0) {
    const calls = Array.from(
      { length: count },
      (_, i) => `  world.entities := array.map (sys_${i} input) self`,
    ).join("\n");
    const head =
      "const update = fn (input: s.Input) => fn (world: s.World) => do:\n";
    if (!main.includes(head)) throw new Error("no update to pad");
    main = main.replace(
      head,
      `${
        Array.from({ length: count }, (_, i) => system(i)).join("\n")
      }\n${head}${calls}\n`,
    );
    if (!/import \* as array/.test(main)) {
      main = `import * as array from "std/array"\n` + main;
    }
  }
  const entry = join(game, "main.blot");
  await Deno.writeTextFile(entry, main);
  const compiler = await createGameCompiler({ entry, schema, catalog });
  const started = performance.now();
  const cold = await compiler.build();
  const coldMs = performance.now() - started;
  if (!cold.ok) {
    console.log(`${example} +${count}: ${cold.diagnostics[0]?.message}`);
    await compiler.dispose();
    continue;
  }
  const times: number[] = [];
  const phases: Record<string, number[]> = {};
  const anchor = /(\d+\.\d+)(?![\s\S]*\d+\.\d+[\s\S]*entry const step)/;
  for (let i = 0; i < edits + 2; i++) {
    const edited = main.replace(
      /(\d+\.\d+)/,
      (_, v) => String(Number(v) + 0.001 * (i + 1)),
    );
    const t = performance.now();
    const r = await compiler.build({ [entry]: edited });
    const ms = performance.now() - t;
    if (i < 2 || !r.ok) continue;
    times.push(ms);
    for (const [k, v] of Object.entries(r.stats.phases)) {
      (phases[k] ??= []).push(v);
    }
  }
  void anchor;
  const phase = Object.entries(phases).map(([k, v]) =>
    `${k} ${percentile(v, 0.5).toFixed(0)}`
  ).join(", ");
  console.log(
    `${example} +${count} systems: wasm ${
      (cold.bytes.length / 1024).toFixed(0)
    } KB, source ${(main.length / 1024).toFixed(0)} KB, cold ${
      coldMs.toFixed(0)
    } ms, edit median ${percentile(times, 0.5).toFixed(0)} ms p95 ${
      percentile(times, 0.95).toFixed(0)
    } ms (backend ms: ${phase})`,
  );
  await compiler.dispose();
  await Deno.remove(dir, { recursive: true });
}
