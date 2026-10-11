import { createCompiler, instantiateGuest } from "@mewhhaha/blot";
import { libraryUrl } from "../mod.ts";
import { compile } from "../tests/support.ts";
import { blotRoot, revision } from "./setup.ts";
import { measure, summary, writeReport } from "./report.ts";

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
let literalAnswer: unknown;

try {
  await Deno.writeTextFile(entry, source);
  for (let round = 0; round < 9; round++) {
    let started = performance.now();
    const compiler = await createCompiler({
      entry,
      imports: { "ink/": libraryUrl },
      executable: new URL("zig-native/zig-out/bin/blotc", blotRoot),
      stdRoot: new URL("std/", blotRoot),
      prelude: new URL("std/prelude.blot", blotRoot),
    });
    if (round >= 2) startup.push(performance.now() - started);
    try {
      started = performance.now();
      const first = await compiler.build();
      if (round >= 2) cold.push(performance.now() - started);
      if (!first.success) throw new Error(JSON.stringify(first.diagnostics));
      wasmBytes = first.bytes.length;

      started = performance.now();
      const same = await compiler.build();
      if (round >= 2) unchanged.push(performance.now() - started);
      if (!same.success) throw new Error(JSON.stringify(same.diagnostics));

      started = performance.now();
      const edited = await compiler.build({
        sources: { [entry]: source.replace("+ 0.0", "+ 0.1") },
      });
      if (round >= 2) incremental.push(performance.now() - started);
      if (!edited.success) throw new Error(JSON.stringify(edited.diagnostics));
      if (round === 8) {
        const guest = await instantiateGuest(edited.bytes);
        try {
          literalAnswer = guest.read("answer");
          if (
            typeof literalAnswer !== "number" ||
            Math.abs(literalAnswer - 1.1) > 1e-6
          ) throw new Error("Literal benchmark witness failed");
        } finally {
          guest.dispose();
        }
      }
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
let terrainMeasurement;
try {
  const rows = 1000;
  const header = [0, 0, 0, 512, 8, 1, 6, 3, 1, rows, 3, 0, 0, 0, 0, 0];
  const grid = new Float32Array(81);
  const queries = Array.from(
    { length: rows },
    (_, i) => [(i % 31) * 8, (i % 27) * 8, 0],
  );
  const lanes = new Float32Array([...header, ...queries.flat(), ...grid]);
  terrainMeasurement = measure(() => {
    const result = terrain.guest.call("heights", lanes);
    if (!(result instanceof Float32Array) || result.length !== rows * 4) {
      throw new Error("Terrain benchmark returned an invalid witness");
    }
    for (let row = 0; row < rows; row++) {
      const offset = row * 4;
      if (
        !Number.isFinite(result[offset]) || result[offset + 1] !== 1 ||
        result[offset] !== result[offset + 2] ||
        result[offset] !== -result[offset + 3]
      ) {
        throw new Error("Terrain height/inside/ground/above witness failed");
      }
    }
    return Array.from(result.slice(0, 4));
  });
  terrainNs = terrainMeasurement.milliseconds.median * 1e6 / rows;
} finally {
  await terrain.dispose();
}

await writeReport("cpu", {
  compiler: revision,
  rounds: startup.length,
  warmup: 2,
  milliseconds: {
    startup: summary(startup),
    coldBuild: summary(cold),
    unchangedBuild: summary(unchanged),
    literalEdit: summary(incremental),
  },
  wasmBytes,
  witness: { literalAnswer },
  terrain: terrainMeasurement,
  terrainHeightInsideGroundAboveNs: Math.round(terrainNs),
});
