import { createCompiler } from "@mewhhaha/blot";
import { libraryUrl, modules } from "../mod.ts";
import { blotRoot } from "./setup.ts";
import { writeReport } from "./report.ts";
import { freemem, loadavg, totalmem } from "node:os";

export interface Workload {
  name: string;
  modules: string[];
  fixture: string;
  entry: string;
  sizes: number[];
  unit: string;
  // A side length represents square work; other sizes represent item counts.
  dimension?: number;
  complexity: string;
  expensive?: boolean;
}

const batch = (
  module: string,
  sizes = [1024, 2048, 4096],
): Workload => ({
  name: module,
  modules: [module],
  fixture: "./library-bench.blot",
  entry: `${module}_batch`,
  sizes,
  unit: "items",
  complexity: "linear",
});
const game = (
  module: string,
  entry: string,
  sizes: number[],
): Workload => ({
  name: module,
  modules: [module],
  fixture: "../tests/game_modules.blot",
  entry,
  sizes,
  unit: "items",
  complexity: "linear",
});

export const workloads: Workload[] = [
  ...["math", "arrays", "random", "noise", "time", "transform", "color"]
    .map((module) => batch(module)),
  batch("lighting"),
  batch("environment", [384, 768, 1536]),
  batch("shadow", [64, 128, 256]),
  batch("motion"),
  batch("steering", [256, 512, 1024]),
  batch("audio"),
  batch("terrain", [256, 512, 1024]),
  batch("tiles"),
  { ...batch("spatial"), complexity: "n log n" },
  { ...batch("scene"), complexity: "n log n" },
  {
    ...batch("spatial", [256, 512, 1024]),
    name: "fully dirty dense spatial refit and queries",
    entry: "spatial_dense",
    complexity: "n log n",
  },
  {
    ...batch("scene", [256, 512, 1024]),
    name: "fully dirty dense scene update and overlaps",
    entry: "scene_dense_update",
    complexity: "n log n",
  },
  batch("shapes", [128, 256, 512]),
  batch("contact", [64, 128, 256]),
  batch("rigid", [64, 128, 256]),
  batch("character", [64, 128, 256]),
  { ...batch("placement", [16, 32, 64]), unit: "columns (16 rows)" },
  batch("debug"),
  game("camera", "cull_workload", [4096, 8192, 16384]),
  game("particles", "particle_workload", [1024, 2048, 4096]),
  {
    ...game("particles", "sprite_workload", [256, 512, 1024]),
    name: "particle vertices",
  },
  {
    ...batch("particles"),
    name: "expired and mixed particle filtering",
    entry: "particles_expired",
  },
  game("animation", "bones_workload", [128, 256, 512]),
  {
    ...batch("animation"),
    name: "animation events (32 cycles)",
    entry: "animation_events",
    sizes: [128, 256, 512],
    unit: "events per cycle",
  },
  {
    ...batch("sort"),
    name: "stable sorting with ties and full U32 keys",
    entry: "sort_ties",
    sizes: [2048, 4096, 8192],
    complexity: "n log n",
  },
  {
    ...batch("physics"),
    name: "sparse physics",
    entry: "physics_sparse",
    sizes: [64, 128, 256],
    unit: "bodies",
    complexity: "n log n",
  },
  {
    ...batch("physics"),
    name: "dense overlapping physics",
    entry: "physics_dense",
    sizes: [16, 32, 64],
    unit: "bodies",
    complexity: "quadratic contact-pair output",
  },
  {
    ...batch("joints"),
    fixture: "../tests/joints.blot",
    entry: "thousand",
    sizes: [256, 512, 1024],
  },
  ...["large", "large_flow"].map((entry) => ({
    ...batch("navigation"),
    name: `navigation ${entry}`,
    fixture: "../tests/navigation.blot",
    entry,
    sizes: [32, 64, 128, 256, 512],
    unit: "cells",
    dimension: 2,
    complexity: "n log n upper bound; A* may prune",
  })),
  ...["unreachable", "budget"].map((kind) => ({
    ...batch("navigation"),
    name: `navigation ${kind}`,
    entry: `navigation_${kind}`,
    sizes: [32, 64, 128, 256],
    unit: "cells",
    dimension: 2,
    complexity: "n log n",
  })),
  {
    ...batch("placement"),
    name: "placement spacing/cell growth",
    entry: "placement_neighbours",
    sizes: [1, 2, 4, 8],
    unit: "spacing/cell ratio",
    complexity: "neighbourhood area and early rejection dependent",
  },
  {
    ...batch("terrain"),
    name: "whole terrain range",
    entry: "terrain_range",
    sizes: [16, 32, 64, 128],
    unit: "cells",
    dimension: 2,
  },
  {
    ...batch("terrain"),
    name: "terrain closest segment",
    modules: ["terrain", "shapes"],
    entry: "terrain_segment",
    sizes: [8, 16, 32, 64],
    unit: "metres of horizontal footprint",
    complexity: "footprint and resolution dependent numerical search",
  },
  {
    ...batch("shapes"),
    name: "redundant convex planes",
    entry: "hull_planes",
    sizes: [6, 12, 24, 48],
    unit: "planes",
    complexity: "up to quartic plane-intersection work",
  },
  {
    ...batch("shapes"),
    name: "unique convex planes",
    entry: "hull_unique",
    sizes: [6, 12, 24, 48],
    unit: "planes",
    complexity: "up to quartic plane-intersection work",
  },
  {
    ...batch("terrain"),
    name: "terrain finest octave growth",
    modules: ["terrain", "shapes"],
    entry: "terrain_detail",
    sizes: [1, 2, 3, 4, 5],
    unit: "noise octaves",
    complexity: "exponential resolution growth",
    expensive: true,
  },
];

/** Independent, small witnesses supplement the property/reference test suite. */
export function checkWitness(
  workload: Workload,
  size: number,
  witness: number[],
) {
  const fail = () => {
    throw new Error(`${workload.name}(${size}) witness: ${witness}`);
  };
  if (
    witness.length === 0 || witness.some((value) => !Number.isFinite(value))
  ) {
    fail();
  }
  if (workload.entry === "cull_workload") {
    if (witness[0] <= 0 || witness[0] > size) fail();
    return;
  }
  if (workload.entry === "particle_workload") {
    if (witness[0] !== size) fail();
    return;
  }
  if (workload.entry === "sprite_workload") {
    if (witness[0] !== size * 54) fail();
    return;
  }
  if (workload.entry === "bones_workload") {
    let position = 0;
    for (let i = 0; i < size; i++) position += 5 * Math.cos(i * 0.5);
    if (Math.abs(witness[0] - position) > 0.01) fail();
    return;
  }
  if (workload.entry === "thousand") {
    if (witness[0] <= size || witness[0] > size * 100) fail();
    return;
  }
  if (workload.entry === "large") {
    if (
      witness[0] !== 2 * (size - 1) || witness[2] !== 2 * size - 1 ||
      witness[1] < witness[2] || witness[1] > size * size
    ) fail();
    return;
  }
  if (workload.entry === "large_flow") {
    if (witness[0] !== 2 * (size - 1)) fail();
    return;
  }
  if (witness[0] !== size) fail();
  switch (workload.entry) {
    case "arrays_batch":
      if (
        witness[1] !== size * (size - 1) / 2 - 1 || witness[2] !== 0 ||
        witness[3] !== Math.fround(0xffffffff)
      ) fail();
      break;
    case "random_batch": {
      let seed = 123;
      for (let i = 0; i < size; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        seed >>>= 0;
      }
      if (witness[1] !== seed || witness[2] !== 0) fail();
      break;
    }
    case "time_batch":
      if (
        witness[1] !== Math.floor(size / 4) || witness[2] !== (size % 4) / 32 ||
        witness[3] !== 1 || witness[4] !== 1
      ) fail();
      break;
    case "math_batch":
    case "transform_batch":
    case "color_batch":
    case "environment_batch":
    case "shadow_batch":
    case "steering_batch":
    case "audio_batch":
    case "terrain_batch":
    case "shapes_batch":
    case "contact_batch":
    case "rigid_batch":
      if (witness[2] < 0 || witness[2] > 0.001) fail();
      break;
    case "noise_batch":
      if (witness[2] > 1.5) fail();
      break;
    case "lighting_batch":
      if (witness[1] <= 0 || witness[2] < 0) fail();
      break;
    case "tiles_batch":
    case "character_batch":
      if (witness[2] !== size) fail();
      break;
    case "spatial_batch":
      if (witness.slice(1).join() !== "1,0,1") fail();
      break;
    case "scene_batch":
      if (witness.slice(1).join() !== "1.5,1,2") fail();
      break;
    case "terrain_range":
      if (witness[1] !== 0 || witness[2] !== 16) fail();
      break;
    case "terrain_segment":
      if (Math.abs(witness[1] - 1) > 0.001 || witness[2] !== 1) fail();
      break;
    case "hull_planes":
      if (witness[1] !== 8 || witness[2] !== size) fail();
      break;
    case "physics_sparse":
      if (Math.abs(witness[1] - 9.9983) > 0.0001 || witness[2] !== 0) fail();
      break;
    case "physics_dense":
      if (witness[2] !== size * (size - 1) / 2) fail();
      break;
    case "placement_batch":
      if (witness[1] <= 0 || witness[1] > size * 16 || witness[3] !== 1) fail();
      break;
    case "debug_batch":
      if (witness.slice(1).join() !== `${size * 14},29,1`) fail();
      break;
    case "animation_events":
      if (witness[1] !== size * 32) fail();
      break;
    case "particles_expired":
      if (witness.slice(1).join() !== `0,${size / 2},0`) fail();
      break;
    case "spatial_dense":
    case "scene_dense_update":
      if (witness.slice(1).join() !== `${size},0,${size},0`) fail();
      break;
    case "navigation_unreachable":
    case "navigation_budget":
      if (witness[1] !== 0) fail();
      break;
    case "placement_neighbours":
      if (witness[1] <= 0 || witness[1] > 1024) fail();
      break;
    case "hull_unique":
      if (witness[1] < 4 || witness[2] !== size || witness[3] < 1.9) fail();
      break;
    case "terrain_detail":
      if (witness[1] < 1.5 || witness[1] > 2.5 || witness[2] < 0.9) fail();
      break;
    case "sort_ties":
      if (witness.slice(1).join() !== "0,0,15") fail();
      break;
  }
}

/** A separate worker can be terminated while a synchronous Wasm call stalls. */
export function runWorkload(
  workload: Workload,
  bytes: Uint8Array,
  deadlineMs = 30_000,
  workerUrl = new URL("./library-bench-worker.ts", import.meta.url),
): Promise<Record<string, unknown>> {
  const worker = new Worker(workerUrl.href, { type: "module" });
  return new Promise((resolve, reject) => {
    let lastColdCall: unknown;
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      finish();
      let message = `${workload.name} exceeded ${deadlineMs}ms; terminated`;
      if (lastColdCall) {
        message += `; last completed cold call: ${
          JSON.stringify(lastColdCall)
        }`;
      }
      reject(
        new Error(message),
      );
    }, deadlineMs);
    worker.onerror = (event) => {
      event.preventDefault();
      finish();
      reject(new Error(`${workload.name}: ${event.message}`));
    };
    worker.onmessage = (event) => {
      if (event.data.ready) {
        worker.postMessage({ workload, bytes });
        return;
      }
      if (event.data.progress) {
        lastColdCall = event.data.progress;
        return;
      }
      finish();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data);
    };
  });
}

async function sourceInventory(active: Workload[]) {
  const files = new Set([
    ...modules.map((module) => `../lib/${module}.blot`),
    ...active.map((item) => item.fixture),
    "./library-bench.ts",
    "./library-bench-worker.ts",
  ]);
  return await Promise.all(
    [...files].sort().map(async (file) => {
      const bytes = await Deno.readFile(new URL(file, import.meta.url));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = [...new Uint8Array(digest)].map((byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      const source = new TextDecoder().decode(bytes);
      const functions = [...source.matchAll(/^const ([\w.]+)[^\n=]*=\s*fn/gm)]
        .map((match) => match[1]);
      return { file, bytes: bytes.length, sha256, functions };
    }),
  );
}

const machineLoad = () => ({
  loadAverage: loadavg(),
  availableMemoryBytes: freemem(),
  totalMemoryBytes: totalmem(),
});

if (import.meta.main) {
  const selected = Deno.args;
  const active = workloads.filter((item) =>
    selected.length === 0 ||
    selected.some((name) =>
      item.name.includes(name) || item.modules.includes(name)
    )
  );
  if (active.length === 0) throw new Error("No matching Blot workloads");
  const covered = new Set(workloads.flatMap((item) => item.modules));
  if (modules.some((module) => !covered.has(module))) {
    throw new Error("Every shipped Blot module needs a benchmark workload");
  }
  const started = performance.now();
  const loadBefore = machineLoad();
  const sources = await sourceInventory(active);
  const compiled = new Map<string, Uint8Array>();
  const builds = [];
  const results = [];
  const failures = [];
  for (const workload of active) {
    let bytes = compiled.get(workload.fixture);
    if (!bytes) {
      const started = performance.now();
      const compiler = await createCompiler({
        entry: new URL(workload.fixture, import.meta.url),
        imports: { "ink/": libraryUrl },
        executable: new URL("zig-native/zig-out/bin/blotc", blotRoot),
        stdRoot: new URL("std/", blotRoot),
        prelude: new URL("std/prelude.blot", blotRoot),
      });
      try {
        const built = await compiler.build();
        if (!built.success) throw new Error(JSON.stringify(built.diagnostics));
        bytes = built.bytes;
        compiled.set(workload.fixture, bytes);
        builds.push({
          fixture: workload.fixture,
          compileMs: performance.now() - started,
          wasmBytes: bytes.length,
        });
      } finally {
        await compiler.dispose();
      }
    }
    try {
      console.error(
        `Measuring ${workload.name} (${workload.sizes.join(", ")})`,
      );
      results.push(await runWorkload(workload, bytes));
    } catch (error) {
      failures.push({ name: workload.name, error: String(error) });
      console.error(String(error));
    }
  }
  const coveredModules = [...new Set(active.flatMap((item) => item.modules))]
    .sort();
  await writeReport("library", {
    scope:
      "Representative batches for every module, plus adversarial scaling cases. This is workload coverage, not exhaustive branch or function coverage.",
    timing:
      "Guest calls include fixture setup and result decoding; compilation, worker startup, witness validation and replay checks are excluded. Sizes are warmed together and sampled in rotating order.",
    memory:
      "Committed Wasm linear memory includes temporary arena capacity. It is not live allocation size; repeated calls must reach a plateau.",
    coveredModules,
    totalModules: modules.length,
    perWorkloadDeadlineMs: 30_000,
    elapsedMs: performance.now() - started,
    machineLoad: { before: loadBefore, after: machineLoad() },
    sources,
    builds,
    results,
    failures,
  });
  if (failures.length > 0) Deno.exitCode = 1;
  console.error(
    `${coveredModules.length}/${modules.length} modules, ${results.length} workloads, ${failures.length} failures. .cache/bench-library.json`,
  );
}
