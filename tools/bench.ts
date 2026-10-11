import { createCompiler } from "@mewhhaha/blot";
import { libraryUrl } from "../mod.ts";
import { compile } from "../tests/support.ts";
import { blotRoot, revision } from "./setup.ts";

const directory = await Deno.makeTempDir({ prefix: "ink-bench-" });
const entry = `${directory}/main.blot`;
const source = `import * as math from "ink/math"
entry const answer: F32 = math.Quat.dot math.identity_quat math.identity_quat + 0.0
`;
const startup: number[] = [];
const cold: number[] = [];
const incremental: number[] = [];
const unchanged: number[] = [];
let wasmBytes = 0;

try {
  await Deno.writeTextFile(entry, source);
  for (let round = 0; round < 7; round++) {
    let started = performance.now();
    const compiler = await createCompiler({
      entry,
      imports: { "ink/": libraryUrl },
      executable: new URL("zig-native/zig-out/bin/blotc", blotRoot),
      stdRoot: new URL("std/", blotRoot),
      prelude: new URL("std/prelude.blot", blotRoot),
    });
    startup.push(performance.now() - started);
    try {
      started = performance.now();
      const first = await compiler.build();
      cold.push(performance.now() - started);
      if (!first.success) throw new Error(JSON.stringify(first.diagnostics));
      wasmBytes = first.bytes.length;

      started = performance.now();
      const same = await compiler.build();
      unchanged.push(performance.now() - started);
      if (!same.success) throw new Error(JSON.stringify(same.diagnostics));

      started = performance.now();
      const edited = await compiler.build({
        sources: { [entry]: source.replace("+ 0.0", "+ 0.1") },
      });
      incremental.push(performance.now() - started);
      if (!edited.success) throw new Error(JSON.stringify(edited.diagnostics));
    } finally {
      await compiler.dispose();
    }
  }
} finally {
  await Deno.remove(directory, { recursive: true });
}

const terrain = await compile(
  new URL("../tests/terrain.blot", import.meta.url),
);
let terrainNs = 0;
try {
  const rows = 1000;
  const header = [0, 0, 0, 512, 8, 1, 6, 3, 1, rows, 3, 0, 0, 0, 0, 0];
  const grid = new Float32Array(81);
  const queries = Array.from(
    { length: rows },
    (_, i) => [(i % 31) * 8, (i % 27) * 8, 0],
  );
  const lanes = new Float32Array([...header, ...queries.flat(), ...grid]);
  terrain.guest.call("heights", lanes);
  const started = performance.now();
  const rounds = 20;
  for (let i = 0; i < rounds; i++) terrain.guest.call("heights", lanes);
  terrainNs = (performance.now() - started) * 1e6 / rounds / rows;
} finally {
  await terrain.dispose();
}

const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify(
  {
    compiler: revision,
    rounds: startup.length,
    milliseconds: {
      startup: median(startup),
      coldBuild: median(cold),
      unchangedBuild: median(unchanged),
      literalEdit: median(incremental),
    },
    wasmBytes,
    terrainHeightInsideGroundAboveNs: Math.round(terrainNs),
  },
  null,
  2,
));
