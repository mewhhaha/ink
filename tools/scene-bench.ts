import { createCompiler, instantiateGuest } from "@mewhhaha/blot";
import { blotRoot, revision } from "./setup.ts";

const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const summary = (values: number[]) => {
  const centre = median(values);
  const deviations = values.map((value) => Math.abs(value - centre));
  return {
    median: Number(centre.toFixed(3)),
    min: Number(Math.min(...values).toFixed(3)),
    max: Number(Math.max(...values).toFixed(3)),
    medianAbsoluteDeviation: Number(median(deviations).toFixed(3)),
  };
};

const counts = [100, 1_000, 10_000];
const kinds = [
  { label: "box", value: 0 },
  { label: "convexBrush", value: 1 },
];
const measuredRounds = 3;
const queryRounds = { baseline: 8, extended: 128 };
const refreshIterations = 1;
const selectedCount = Deno.args[1];
let activeCounts = counts;
if (selectedCount !== undefined) {
  activeCounts = [Number(selectedCount)];
}
const fixture = new URL("./scene-bench.blot", import.meta.url);
const mode = Deno.args[0] ?? "after";
let libraryDirectory: URL;
if (mode === "before") {
  libraryDirectory = new URL("../.cache/scene-baseline-lib/", import.meta.url);
} else {
  libraryDirectory = new URL("../lib/", import.meta.url);
}
const compileStarted = performance.now();
const compiler = await createCompiler({
  entry: fixture,
  imports: { "ink/": libraryDirectory },
  executable: new URL("zig-native/zig-out/bin/blotc", blotRoot),
  stdRoot: new URL("std/", blotRoot),
  prelude: new URL("std/prelude.blot", blotRoot),
});
const built = await compiler.build();
if (!built.success) {
  await compiler.dispose();
  throw new Error(JSON.stringify(built.diagnostics, null, 2));
}
const guest = await instantiateGuest(built.bytes);
const callF32 = (name: string, args: Float32Array): Float32Array => {
  const result = guest.call(name, args);
  if (!(result instanceof Float32Array)) {
    throw new Error(`scene benchmark ${name} returned a non-F32 result`);
  }
  return result;
};
function checkQueries(result: Float32Array) {
  for (
    const [start, rounds] of [
      [3, queryRounds.baseline],
      [9, queryRounds.extended],
    ]
  ) {
    for (let i = start; i < start + 4; i++) {
      if (result[i] !== rounds) {
        throw new Error("scene benchmark lost a query hit or miss");
      }
    }
  }
}
const compileMs = performance.now() - compileStarted;

try {
  const callStarted = performance.now();
  const warm = callF32("noop", new Float32Array([0]));
  const noopStartupMs = performance.now() - callStarted;
  if (warm[0] !== 1) throw new Error("scene benchmark noop checksum failed");

  const noopSamples: number[] = [];
  for (let i = 0; i < measuredRounds; i++) {
    const started = performance.now();
    const result = callF32("noop", new Float32Array([i]));
    noopSamples.push(performance.now() - started);
    if (result[0] !== i + 1) {
      throw new Error("scene benchmark noop checksum failed");
    }
  }

  const results = [];
  for (const count of activeCounts) {
    for (const kind of kinds) {
      const args = new Float32Array([count, kind.value]);
      const buildSamples: number[] = [];
      const buildWarm = callF32("build", args);
      let buildChecksum = buildWarm[0];

      const querySamples: number[] = [];
      const queryDiffSamples: number[] = [];
      const queryArgs = new Float32Array([
        count,
        kind.value,
        queryRounds.baseline,
        queryRounds.extended,
      ]);
      const queryWarm = callF32("queries", queryArgs);
      checkQueries(queryWarm);
      let queryChecksum = Array.from(queryWarm);
      for (let round = 0; round < measuredRounds; round++) {
        let started = performance.now();
        const pairedBuild = callF32("build", args);
        const pairedBuildMs = performance.now() - started;
        buildSamples.push(pairedBuildMs);
        buildChecksum = pairedBuild[0];

        started = performance.now();
        const result = callF32("queries", queryArgs);
        const queryMs = performance.now() - started;
        checkQueries(result);
        querySamples.push(queryMs);
        queryDiffSamples.push(queryMs - pairedBuildMs);
        queryChecksum = Array.from(result);
      }

      const refreshArgs = new Float32Array([
        count,
        kind.value,
        refreshIterations,
      ]);
      const refreshWarm = callF32("refresh", refreshArgs);
      if (refreshWarm[0] !== refreshWarm[1]) {
        throw new Error("scene refresh changed a static proxy");
      }
      if (refreshWarm[2] === refreshWarm[3]) {
        throw new Error("scene refresh did not move a mover proxy");
      }
      const refreshSamples: number[] = [];
      const refreshDiffSamples: number[] = [];
      let refreshChecksum = Array.from(refreshWarm);
      for (let round = 0; round < measuredRounds; round++) {
        let started = performance.now();
        const pairedBuild = callF32("build", args);
        const pairedBuildMs = performance.now() - started;
        buildSamples.push(pairedBuildMs);
        buildChecksum = pairedBuild[0];

        started = performance.now();
        const result = callF32("refresh", refreshArgs);
        const refreshMs = performance.now() - started;
        refreshSamples.push(refreshMs);
        refreshDiffSamples.push(refreshMs - pairedBuildMs);
        refreshChecksum = Array.from(result);
        if (result[0] !== result[1]) {
          throw new Error("scene refresh changed a static proxy");
        }
      }

      const buildMs = median(buildSamples);
      const queryCallMs = median(querySamples);
      const refreshBundleMs = median(refreshSamples);
      results.push({
        count,
        geometry: kind.label,
        sceneBuildAndIndexMs: Number(buildMs.toFixed(3)),
        queryBundleMsIncludingBuild: Number(queryCallMs.toFixed(3)),
        queryBatches: queryRounds,
        queryCountInCall: (queryRounds.baseline + queryRounds.extended) * 4,
        pairedQueryEstimateMs: summary(queryDiffSamples),
        refreshIterations,
        refreshBundleMs: Number(refreshBundleMs.toFixed(3)),
        pairedRefreshEstimateMsPerUpdate: summary(
          refreshDiffSamples.map((value) => value / refreshIterations),
        ),
        checksum: {
          build: Number(buildChecksum.toFixed(6)),
          queryScene: Number(queryChecksum[0].toFixed(6)),
          baselineRays: Number(queryChecksum[1].toFixed(6)),
          baselineOverlaps: Number(queryChecksum[2].toFixed(6)),
          baselineRayHits: queryChecksum[3],
          baselineRayMisses: queryChecksum[4],
          baselineOverlapHits: queryChecksum[5],
          baselineOverlapMisses: queryChecksum[6],
          extendedRays: Number(queryChecksum[7].toFixed(6)),
          extendedOverlaps: Number(queryChecksum[8].toFixed(6)),
          extendedRayHits: queryChecksum[9],
          extendedRayMisses: queryChecksum[10],
          extendedOverlapHits: queryChecksum[11],
          extendedOverlapMisses: queryChecksum[12],
          staticBeforeRefresh: Number(refreshChecksum[0].toFixed(6)),
          staticAfterRefresh: Number(refreshChecksum[1].toFixed(6)),
          moversBeforeRefresh: Number(refreshChecksum[2].toFixed(6)),
          moversAfterRefresh: Number(refreshChecksum[3].toFixed(6)),
          sceneAfterRefresh: Number(refreshChecksum[4].toFixed(6)),
        },
      });
    }
  }

  let refreshApi = "scene.update";
  if (mode === "before") refreshApi = "baseline rebuild shim";
  const report = {
    compilerRevision: revision,
    deno: Deno.version.deno,
    v8: Deno.version.v8,
    typescript: Deno.version.typescript,
    target: `${Deno.build.os}-${Deno.build.arch}`,
    hardwareConcurrency: navigator.hardwareConcurrency,
    warm: true,
    rounds: measuredRounds,
    queryRounds,
    refreshIterations,
    compileAndInstantiateMs: Number(compileMs.toFixed(3)),
    firstGuestCallMs: Number(noopStartupMs.toFixed(3)),
    guestBoundaryMedianMs: Number(median(noopSamples).toFixed(3)),
    mode,
    refreshApi,
    results,
  };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  const output = new URL(`../.cache/scene-${mode}.json`, import.meta.url);
  await Deno.writeTextFile(output, `${json}\n`);
} finally {
  try {
    guest.dispose();
  } finally {
    await compiler.dispose();
  }
}
