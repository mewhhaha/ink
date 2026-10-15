import { createCompiler } from "@mewhhaha/blot";
import { libraryUrl, modules } from "../mod.ts";
import { blotRoot } from "./setup.ts";
import { writeReport } from "./report.ts";
import { freemem, loadavg, totalmem } from "node:os";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
  ...["sparse", "dense", "dense_outputs"].map((entry) => ({
    name: `flock ${entry.replaceAll("_", " ")} (eight-neighbour budget)`,
    modules: ["steering", "spatial"],
    fixture: "../tests/perf/flock-performance.blot",
    entry,
    sizes: [128, 512, 2048],
    unit: "members",
    complexity: "linear (fixed query radius and budget)",
  })),
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
  ...["dense", "sparse", "churn"].map((entry) => ({
    name: `ecs ${entry}`,
    modules: ["ecs"],
    fixture: "../tests/ecs.blot",
    entry,
    sizes: [256, 512, 1024],
    unit: "entities",
    complexity: "linear",
  })),
  {
    name: "application scheduling",
    modules: ["app"],
    fixture: "../tests/app-hooks.blot",
    entry: "schedule_workload",
    sizes: [256, 512, 1024],
    unit: "frames",
    complexity: "linear",
  },
  {
    name: "clock scheduling",
    modules: ["clock"],
    fixture: "../tests/clock.blot",
    entry: "steps",
    sizes: [256, 512, 1024],
    unit: "ticks",
    complexity: "linear",
  },
  {
    name: "persistence round trips",
    modules: ["persist", "lanes"],
    fixture: "../tests/persist.blot",
    entry: "roundtrip",
    sizes: [256, 512, 1024],
    unit: "entities",
    complexity: "linear",
  },
  {
    name: "ui controls and caller glyphs",
    modules: ["ui", "ui/font"],
    fixture: "../tests/ui_boundaries.blot",
    entry: "ui_workload",
    sizes: [256, 512, 1024],
    unit: "controls",
    complexity: "linear",
  },
  {
    name: "normalized input",
    modules: ["input", "input/keys", "events"],
    fixture: "../tests/input.blot",
    entry: "input_workload",
    sizes: [256, 512, 1024],
    unit: "events",
    complexity: "linear",
  },
  {
    name: "ui focus and menus",
    modules: ["ui/tree", "ui/vocabulary", "menu", "logic"],
    fixture: "../tests/migration-bench.blot",
    entry: "ui_tree_menu",
    sizes: [64, 128, 256],
    unit: "frames",
    complexity: "linear",
  },
  {
    name: "preferences and tunables",
    modules: ["preferences", "tune"],
    fixture: "../tests/migration-bench.blot",
    entry: "preference_tune",
    sizes: [256, 512, 1024],
    unit: "edits",
    complexity: "linear",
  },
  {
    name: "unicode and numeric text",
    modules: ["text"],
    fixture: "../tests/migration-bench.blot",
    entry: "text_workload",
    sizes: [256, 512, 1024],
    unit: "lines",
    complexity: "linear",
  },
  {
    name: "service request and response",
    modules: ["services"],
    fixture: "../tests/migration-bench.blot",
    entry: "service_workload",
    sizes: [64, 128, 256],
    unit: "requests",
    complexity: "linear",
  },
  {
    name: "sound and voice declarations",
    modules: ["sound"],
    fixture: "../tests/migration-bench.blot",
    entry: "sound_workload",
    sizes: [64, 128, 256],
    unit: "sounds and voices",
    complexity: "linear",
  },
  ...[
    {
      name: "brush reconstruction",
      modules: ["brush"],
      entry: "brushes",
      sizes: [16, 32, 64],
    },
    {
      name: "daylight palette",
      modules: ["daylight"],
      entry: "lighting",
      sizes: [256, 512, 1024],
    },
    {
      name: "bounded orbit movement",
      modules: ["orbit"],
      entry: "orbits",
      sizes: [128, 256, 512],
    },
    {
      name: "polyline sampling",
      modules: ["path"],
      entry: "paths",
      sizes: [256, 512, 1024],
    },
    {
      name: "analytic ground segments",
      modules: ["navigation/ground"],
      entry: "ground_segments",
      sizes: [256, 512, 1024],
    },
    {
      name: "gizmos sky and shadow",
      modules: ["gizmos", "graphics", "render"],
      entry: "gizmos_graphics",
      sizes: [64, 128, 256],
    },
    {
      name: "polar plot lookup",
      modules: ["polar"],
      entry: "plots",
      sizes: [128, 256, 512],
    },
    {
      name: "editor picking and view projection",
      modules: ["editor", "picking", "view"],
      entry: "picking_view",
      sizes: [256, 512, 1024],
    },
  ].map((workload) => ({
    ...workload,
    fixture: "../tests/migrated_geometry.blot",
    unit: "items",
    complexity: "linear",
  })),
  ...["text_join_many", "text_words_long", "text_lines_long"].map((entry) => ({
    name: entry.replaceAll("_", " "),
    modules: ["text"],
    fixture: "../tests/ui_text-performance.blot",
    entry,
    sizes: [1024, 2048, 4096],
    unit: "parts",
    complexity: "linear",
  })),
  {
    name: "deep modal UI tree",
    modules: ["ui/tree"],
    fixture: "../tests/ui_text-performance.blot",
    entry: "ui_deep_tree",
    sizes: [512, 1024, 2048],
    unit: "nodes",
    complexity: "n log n (bounded ancestors)",
  },
  {
    name: "animation late key queries",
    modules: ["animation"],
    fixture: "../tests/perf/animation-input.blot",
    entry: "late_queries",
    sizes: [16, 128, 1024, 8192],
    unit: "keys (1024 queries)",
    complexity: "linear fixture setup + logarithmic lookup",
  },
  {
    name: "input codec saturation",
    modules: ["input"],
    fixture: "../tests/perf/animation-input.blot",
    entry: "input_codec",
    sizes: [64, 128, 256, 512],
    unit: "held keys",
    complexity: "n log n",
  },
  {
    name: "sparse and culled render columns",
    modules: ["render"],
    fixture: "../tests/performance-presentation.blot",
    entry: "render_columns",
    sizes: [256, 1024, 4096],
    unit: "columns",
    complexity: "linear",
  },
  ...[
    {
      name: "Pen UI parent encoding",
      modules: ["pen/host"],
      entry: "wire_tree",
      sizes: [512, 1024, 2048],
    },
    {
      name: "Pen frame packing",
      modules: ["pen/host"],
      entry: "frame_packet",
      sizes: [256, 1024, 4096],
    },
    {
      name: "Pen event decoding",
      modules: ["pen/events"],
      entry: "decoded_events",
      sizes: [256, 1024, 4096],
    },
    {
      name: "Pen session commands",
      modules: ["pen/program"],
      entry: "commands",
      sizes: [256, 1024, 4096],
    },
    {
      name: "Pen platform codec",
      modules: ["pen/platform"],
      entry: "platform_codec",
      sizes: [128, 512, 2048],
    },
    {
      name: "Pen service requests",
      modules: ["pen/services"],
      entry: "service_requests",
      sizes: [32, 64, 128],
      complexity: "bounded quadratic deduplication",
    },
    {
      name: "Pen settings controls",
      modules: ["pen/settings"],
      entry: "settings_controls",
      sizes: [256, 1024, 4096],
    },
  ].map((workload) => ({
    fixture: "../tests/performance-adapters.blot",
    unit: "items",
    complexity: "linear",
    ...workload,
  })),
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
  if (workload.fixture === "../tests/ui_text-performance.blot") {
    if (workload.entry === "ui_deep_tree") {
      const expected = [
        size,
        32,
        32,
        4294967295 - size + 32,
        4294967295 - size + 32,
        size - 32,
      ];
      if (witness.join() !== expected.join()) fail();
    } else {
      let points = 0;
      if (workload.entry === "text_join_many") {
        for (let i = 0; i < size; i++) points += 128578 + 97 + i % 26;
        points += (size - 1) * (10 + 66615);
        if (witness.join() !== [size, size * 4 - 2, points].join()) fail();
      } else {
        for (let i = 0; i < size; i++) points += 128578 + 97 + i % 26;
        let parts = size;
        if (workload.entry === "text_lines_long") parts++;
        if (witness.join() !== [size, parts, size * 2, points].join()) fail();
      }
    }
    return;
  }
  if (workload.entry === "late_queries") {
    let sum = Math.fround(0);
    for (let i = 0; i < 1024; i++) {
      sum = Math.fround(sum + size - 2 + (i % 4) * 0.25);
    }
    if (witness.join() !== [sum].join()) fail();
    return;
  }
  if (workload.entry === "input_codec") {
    if (witness.join() !== [size, size * (size + 1) * (size + 2) / 6].join()) {
      fail();
    }
    return;
  }
  if (workload.fixture === "../tests/perf/flock-performance.blot") {
    if (workload.entry === "sparse") {
      const rows = size / 32;
      const neighbours = 2 * (31 * rows + (rows - 1) * 32);
      if (witness.join() !== [neighbours, size, size, 0].join()) fail();
    } else if (workload.entry === "dense_outputs") {
      if (witness.join() !== [size, 4.5 * size - 3.5].join()) fail();
    } else {
      if (
        witness.length !== 4 ||
        witness.slice(0, 3).join() !==
          [8 * size, 4.5 * size - 3.5, 4.5 * size - 3.5].join() ||
        Math.abs(witness[3] - 32 * size) > 0.1
      ) fail();
    }
    return;
  }
  if (workload.entry === "render_columns") {
    let sum = 0;
    let ids = 0;
    for (let i = 0; i < size; i++) {
      if (i % 4 >= 2) {
        sum += i - 1;
        ids += i;
      }
    }
    if (witness.join() !== [size / 2, sum, ids].join()) fail();
    return;
  }
  if (workload.fixture === "../tests/performance-adapters.blot") {
    switch (workload.entry) {
      case "wire_tree":
        if (
          witness.join() !==
            [size, size * (size - 1) / 2, size * (size + 1) / 2, size].join()
        ) fail();
        break;
      case "frame_packet":
        if (
          witness.join() !==
            [153 + size * 24, size, size * (size - 1) / 2].join()
        ) fail();
        break;
      case "decoded_events":
        if (
          witness.join() !== [size, size * 65 + size * (size - 1) / 2].join()
        ) fail();
        break;
      case "commands":
        if (witness.join() !== [4, size * (size - 1) / 2, 1].join()) fail();
        break;
      case "platform_codec": {
        let sum = 0;
        for (let i = 0; i < size; i++) sum += 65 + i % 26;
        if (witness.join() !== [size + 14, size, sum, 4].join()) fail();
        break;
      }
      case "service_requests":
        if (
          witness.join() !== [size, size * 65 + size * (size - 1) / 2].join()
        ) fail();
        break;
      case "settings_controls": {
        let sum = Math.fround(0);
        for (let i = 0; i < size; i++) {
          sum = Math.fround(sum + Math.fround((i % 100) * Math.fround(0.01)));
        }
        if (witness[0] !== size * 4 || Math.abs(witness[1] - sum) > 0.001) {
          fail();
        }
        break;
      }
    }
    return;
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
  if (
    workload.entry === "ui_workload" || workload.entry === "preference_tune"
  ) {
    let expected = 0;
    for (let i = 0; i < size; i++) {
      expected += 2 * (i % 101) * 0.01;
      if (workload.entry === "ui_workload") expected += 13;
    }
    let actual = witness[0];
    if (workload.entry === "preference_tune") {
      if (witness[0] !== size || witness[2] !== 2) fail();
      actual = witness[1];
    }
    if (Math.abs(actual - expected) > Math.max(0.001, size * 0.00001)) fail();
    return;
  }
  if (workload.entry === "input_workload") {
    if (witness[0] !== 2 * size - 1) fail();
    return;
  }
  if (workload.entry === "schedule_workload") {
    if (witness.join() !== `${size},${size},${size * (size + 1) / 2}`) fail();
    return;
  }
  if (workload.entry === "steps") {
    if (witness.join() !== `${size},${size}`) fail();
    return;
  }
  if (workload.entry === "roundtrip") {
    if (
      witness.join() !==
        `${size},${size},${size * (size - 1) / 2},${5 * size + 20}`
    ) fail();
    return;
  }
  if (["dense", "sparse", "churn"].includes(workload.entry)) {
    let live = size;
    let sum = 0;
    let prior = 0;
    for (let i = 0; i < size; i++) {
      if (workload.entry === "churn" && i % 4 === 0) {
        live--;
        continue;
      }
      prior += i;
      sum += i;
      if (
        workload.entry === "dense" ||
        workload.entry === "sparse" && i % 16 === 0 ||
        workload.entry === "churn" && i % 4 !== 1
      ) sum += 3;
    }
    if (witness.join() !== `${size},${live},${sum},${prior}`) fail();
    return;
  }
  if (workload.fixture === "../tests/migrated_geometry.blot") {
    switch (workload.entry) {
      case "brushes":
        if (witness.join() !== `${8 * size},${size * (size + 1) / 2}`) fail();
        break;
      case "lighting": {
        const smooth = (low: number, high: number, value: number) => {
          const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
          return t * t * (3 - 2 * t);
        };
        let expected = 0;
        for (let i = 0; i < size; i++) {
          const height = Math.sin(((i % 1000 + 0.5) / 1000) * Math.PI * 2);
          const day = smooth(-0.18, 0.25, height);
          const twilight = 1 - smooth(0, 0.3, Math.abs(height));
          const strength = smooth(0, 0.3, Math.abs(height));
          let color = 1.15;
          if (height < 0) color = 0.12;
          expected += color * strength + 0.075 + 0.25 * day + 0.015 * twilight;
        }
        if (
          witness[0] !== size || Math.abs(witness[1] - expected) > size * 0.0001
        ) fail();
        break;
      }
      case "orbits": {
        const pitch = Math.min(1.4, 0.6 + size * 0.0005);
        const yaw = (Math.PI * 2 - size * 0.005 % (Math.PI * 2)) %
          (Math.PI * 2);
        if (
          Math.hypot(witness[0], witness[2]) > 10.0001 ||
          Math.abs(witness[1] - 6 * Math.sin(pitch)) > 0.001 ||
          Math.abs(witness[3] - yaw) > 0.001 ||
          Math.abs(witness[4] - pitch) > 0.001
        ) fail();
        break;
      }
      case "paths": {
        let expected = 0;
        for (let i = 0; i < size; i++) {
          const at = i % 8;
          expected += at;
          if (at >= 3) expected += Math.PI / 2;
        }
        if (
          witness[0] !== 7 || Math.abs(witness[1] - expected) > size * 0.0001
        ) fail();
        break;
      }
      case "ground_segments":
      case "plots":
        if (witness.join() !== `${size},${size}`) fail();
        break;
      case "gizmos_graphics":
        if (
          witness.join() !== `${18 * size},${2048 * size},${1.041015625 * size}`
        ) fail();
        break;
      case "picking_view":
        if (witness.join() !== `${size},${4 * size},${565 * size}`) fail();
        break;
    }
    return;
  }
  if (witness[0] !== size) fail();
  switch (workload.entry) {
    case "ui_tree_menu":
      if (witness.slice(1).join() !== `3,1,${2 * size},${size}`) fail();
      break;
    case "preference_tune":
      break;
    case "text_workload": {
      let expected = 0;
      for (let i = 0; i < size; i++) expected += (i % 100) * 0.25;
      const formats = [
        "1.25",
        "1.250000",
        "Infinity",
        "NaN",
        "1.000000e20",
        "",
      ];
      const bounded = formats.join("").split("").reduce(
        (sum, code) => sum + code.codePointAt(0)!,
        0,
      );
      if (
        witness.length !== 4 || witness[1] !== expected ||
        witness[2] !== size * 3 || witness[3] !== bounded * size
      ) fail();
      break;
    }
    case "service_workload":
      if (witness.slice(1).join() !== `${size},${size * (size + 4)},0,0`) {
        fail();
      }
      break;
    case "sound_workload":
      if (witness.slice(1).join() !== `${size},${size},1,0`) fail();
      break;
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

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function sourceInventory(active: Workload[]) {
  const files = new Set([
    ...modules.map((module) => `../lib/${module}.blot`),
    ...active.map((item) => item.fixture),
    "./library-bench.ts",
    "./library-bench-worker.ts",
    "./report.ts",
    "./toolchain.ts",
    "./setup.ts",
    "./cache.ts",
    "../tests/check.blot",
    "../tests/ui_font.blot",
    ...["protocol", "protocol_render", "types", "lanes"].map((name) =>
      `../tests/fixtures/pen/${name}.blot`
    ),
    "../tests/fixtures/pen/provenance.json",
  ]);
  const directory = dirname(fileURLToPath(import.meta.url));
  const prelude = new URL("std/prelude.blot", blotRoot);
  files.add(relative(directory, fileURLToPath(prelude)));
  // Include imported fixture helpers and the actual pinned standard library.
  // Inventorying only entry files can miss changes to a measured workload.
  for (const file of files) {
    if (!file.endsWith(".blot")) continue;
    const url = new URL(file, import.meta.url);
    const source = await Deno.readTextFile(url);
    for (const match of source.matchAll(/^import .* from "([^"]+)"/gm)) {
      const name = match[1];
      let target: URL;
      if (name.startsWith("std/")) target = new URL(`${name}.blot`, blotRoot);
      else if (name.startsWith("ink/")) {
        target = new URL(`${name.slice(4)}.blot`, libraryUrl);
      } else if (name.startsWith("pen/")) {
        target = new URL(
          `../tests/fixtures/pen/${name.slice(4)}.blot`,
          import.meta.url,
        );
      } else target = new URL(`${name}.blot`, url);
      files.add(relative(directory, fileURLToPath(target)));
    }
  }
  return await Promise.all(
    [...files].sort().map(async (file) => {
      const bytes = await Deno.readFile(new URL(file, import.meta.url));
      const digest = await sha256(bytes);
      const source = new TextDecoder().decode(bytes);
      const functions = [...source.matchAll(/^const ([\w.]+)[^\n=]*=\s*fn/gm)]
        .map((match) => match[1]);
      return { file, bytes: bytes.length, sha256: digest, functions };
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
    throw new Error("Every Blot module needs a benchmark workload");
  }
  const started = performance.now();
  const loadBefore = machineLoad();
  const sources = await sourceInventory(active);
  const compilerBytes = await Deno.readFile(
    new URL("zig-native/zig-out/bin/blotc", blotRoot),
  );
  const compilerSha256 = await sha256(compilerBytes);
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
        imports: {
          "ink/": libraryUrl,
          "pen/": new URL("../tests/fixtures/pen/", import.meta.url),
        },
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
          wasmSha256: await sha256(bytes),
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
      "Representative and adversarial batches for every module. Optional Pen adapters use an independent frozen binding fixture. This is workload coverage, not exhaustive branch or function coverage.",
    timing:
      "Guest calls include fixture setup and result decoding; compilation, worker startup, witness validation and replay checks are excluded. Sizes are warmed together and sampled in rotating order.",
    memory:
      "Committed Wasm linear memory includes temporary arena capacity. It is not live allocation size; repeated calls must reach a plateau.",
    coveredModules,
    totalModules: modules.length,
    optionalAdapters: modules.filter((module) => module.startsWith("pen/")),
    perWorkloadDeadlineMs: 30_000,
    elapsedMs: performance.now() - started,
    machineLoad: { before: loadBefore, after: machineLoad() },
    sources,
    compilerSha256,
    builds,
    results,
    failures,
  });
  if (failures.length > 0) Deno.exitCode = 1;
  console.error(
    `${coveredModules.length}/${modules.length} modules, ${results.length} workloads, ${failures.length} failures. .cache/bench-library.json`,
  );
}
