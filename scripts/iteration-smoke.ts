/**
 * Iteration gate (hill 12): measures save-to-pixels in a running editor.
 *
 * For each example it copies the project, starts the dev server and a
 * Chromium editor, presses play, and then repeatedly
 *   - edits a number inside the game's Blot code on disk (a real rebuild),
 *   - edits a schema default on disk (schema import, regenerated module,
 *     rebuild),
 *   - edits a value in the scene file on disk (applied to the document and,
 *     while playing, to the live world),
 *   - changes a component value through the live API, which takes the same
 *     path as an inspector field,
 * and reads back the editor's own save-to-pixels traces (`profile`): file
 * written, watcher, queue, compiler, transport, fetch, Wasm compile,
 * instantiate, session swap, next frame, step, extraction, draw, render
 * submit, GPU and the animation frame after the GPU finished.
 *
 *   deno task test:iteration [--hardware] [--headed] [--example=godot,feel]
 *                            [--iterations=12] [--no-assert]
 *
 * With `--hardware` a software adapter is rejected and the budgets are
 * asserted on the medians (code 150 ms, tuning 50 ms). Without it the numbers
 * are reported only: SwiftShader draws a frame in tens to hundreds of
 * milliseconds, which dominates the last stages. Writes
 * `tmp/iteration-report-<software|hardware>.json`.
 */
import { assert } from "@std/assert";
import { join } from "@std/path";
import { chromium } from "playwright-core";
import { findChromium, startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import { percentile } from "@ink/core";
import type { LoopTrace, ProfileSnapshot, TraceKind } from "@ink/core";

const args = new Map(
  Deno.args.map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"] as const;
  }),
);
const hardware = args.has("hardware");
const headed = args.has("headed");
const assertBudgets = hardware && !args.has("no-assert");
const iterations = Number(args.get("iterations") ?? 12);
const warmup = 2;
const wanted = (args.get("example") ?? "feel,godot,tiles,trenchbroom,hammer")
  .split(",");
const suffix = hardware ? "hardware" : "software";
const BUDGET: Record<string, number> = {
  code: 150,
  tuning: 50,
  inspector: 50,
  scene: 50,
  "tuning (paused)": 50,
  "inspector (paused)": 50,
  "scene (paused)": 50,
};

/** A number in the game's code, and one in the schema, that can be changed. */
const EDITS: Record<
  string,
  { code: string; schema: string; asset?: string }
> = {
  feel: {
    code: "abs target > 0.01",
    schema: 'run_speed: tuning("Run", { default: 8,',
  },
  godot: {
    code: "f.length_squared > 0.0001",
    schema: "speed: f32({ default: 6,",
  },
  tiles: {
    code: "h.jump_speed * 0.7",
    schema: 'jump_speed: tuning("Jump", { default: 13.5,',
    asset: "assets/tiles.png",
  },
  trenchbroom: {
    code: "delta.x * 0.0022",
    schema: "",
  },
  hammer: {
    code: "turn.y * 80.0 * dt",
    schema: "",
    asset: "assets/textures/brick.png",
  },
};

async function copy(from: string, to: string) {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    if (
      entry.name.startsWith(".") || entry.name === "dist" ||
      entry.name === "dist-desktop" || entry.name === "node_modules"
    ) continue;
    if (entry.isDirectory) {
      await copy(`${from}/${entry.name}`, `${to}/${entry.name}`);
    } else await Deno.copyFile(`${from}/${entry.name}`, `${to}/${entry.name}`);
  }
}

async function prepare(name: string) {
  const dir = `tmp/iteration/${name}`;
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await copy(`examples/${name}`, dir);
  // Edits elsewhere in the workspace must not reload the page mid-run.
  const config = (await Deno.readTextFile(`${dir}/ink.config.ts`)).replace(
    "defineProject({",
    'defineProject({\n  vite: { server: { watch: { ignored: ["**/packages/**", "**/examples/**", "**/tmp/iteration/!(' +
      name + ')/**"] } } },',
  );
  await Deno.writeTextFile(`${dir}/ink.config.ts`, config);
  return dir;
}

const epochNow = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const executablePath = await findChromium();
const browser = await chromium.launch({
  executablePath,
  headless: !headed,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    ...(hardware
      ? [
        "--use-angle=vulkan",
        "--disable-vulkan-surface",
        "--enable-webgpu-developer-features",
      ]
      : [
        "--use-vulkan=swiftshader",
        "--use-webgpu-adapter=swiftshader",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ]),
  ],
});

interface Series {
  totals: number[];
  stages: Map<string, number[]>;
  files: Set<string>;
  detail: Record<string, number | string>;
  unchanged: number;
  failed: number;
}
const series = () => ({
  totals: [],
  stages: new Map(),
  files: new Set(),
  detail: {},
  unchanged: 0,
  failed: 0,
} as Series);

type Report = Record<string, Record<string, unknown>>;
const report: Report = {};
const failures: string[] = [];
let adapterInfo = "";

try {
  for (const name of wanted) {
    const edits = EDITS[name];
    if (!edits) throw new Error(`no edit anchors for ${name}`);
    const dir = await prepare(name);
    const project = await resolveProject(dir);
    const server = await startServer(project, { port: 0, quiet: true });
    const port = (server.httpServer!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(base);
      let session = "";
      for (let i = 0; i < 400 && !session; i++) {
        const list = await (await fetch(`${base}/__ink/live/sessions`)).json();
        session = list[0]?.id ?? "";
        if (!session) await sleep(100);
      }
      assert(session, "the editor never registered");
      const call = async <T = unknown>(
        method: string,
        params: Record<string, unknown> = {},
      ): Promise<T> => {
        const response = await fetch(`${base}/__ink/live/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session, method, params }),
        });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error);
        return value as T;
      };
      type World = {
        state: {
          entities: {
            id: number;
            components: Record<string, Record<string, unknown>>;
          }[];
        };
        status: { kind: string; revision: number };
        mode: string;
        paused: boolean;
      };
      const world = () => call<World>("world");
      const profile = () => call<ProfileSnapshot>("profile");
      for (let i = 0; i < 300; i++) {
        const w = await world().catch(() => null);
        if (w?.status.kind === "ready") break;
        await sleep(100);
      }
      if (!adapterInfo) {
        adapterInfo = await page.evaluate(async () => {
          const adapter = await navigator.gpu.requestAdapter();
          const info = adapter?.info;
          return `${info?.vendor} ${info?.architecture} ${info?.description}`
            .trim();
        });
        const software = /swiftshader|llvmpipe|software/i.test(adapterInfo);
        console.log(`adapter: ${adapterInfo}`);
        if (hardware) assert(!software, "--hardware got a software adapter");
      }
      await call("play", { action: "play" });
      // The game must be stepping before anything is measured.
      for (let i = 0; i < 300; i++) {
        if ((await profile()).metrics.step.samples >= 30) break;
        await sleep(100);
      }
      await sleep(300);

      const seen = new Set<string>((await profile()).traces.map((t) => t.id));
      // The next trace of `kind` for an edit made after `since`: a repeated
      // file event for an earlier write must not be taken for this one.
      const next = async (kind: TraceKind, since: number, timeout = 30000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const snap = await profile();
          const trace = snap.traces.find((t) =>
            !seen.has(t.id) && t.kind === kind && t.start >= since - 20
          );
          if (trace) {
            seen.add(trace.id);
            return trace;
          }
          await sleep(25);
        }
        return null;
      };

      const all: Record<string, Series> = {};
      const record = (label: string, trace: LoopTrace | null) => {
        const s = all[label] ??= series();
        if (!trace) {
          s.failed++;
          console.log(`  ${label}: no trace within the timeout`);
          return;
        }
        if (trace.outcome === "unchanged") {
          s.unchanged++;
          return;
        }
        if (trace.outcome !== "presented") {
          s.failed++;
          console.log(
            `  ${label}: ${trace.outcome} ${trace.file} ${
              trace.stages.map((x) => `${x.stage} ${x.ms.toFixed(0)}`).join(
                ", ",
              )
            }`,
          );
          return;
        }
        s.files.add(trace.file);
        s.totals.push(trace.total);
        Object.assign(s.detail, trace.detail);
        for (const st of trace.stages) {
          const list = s.stages.get(st.stage) ?? [];
          list.push(st.ms);
          s.stages.set(st.stage, list);
        }
      };
      // Warm-up edits are done but dropped (first compile, JIT, caches).
      const bump = (text: string, anchor: string, n: number) => {
        assert(text.includes(anchor), `anchor not found: ${anchor}`);
        const last = [...anchor.matchAll(/\d+(\.\d+)?/g)].at(-1);
        assert(last, `no number in ${anchor}`);
        const value = (parseFloat(last[0]) * (1 + 0.003 * n)).toPrecision(6);
        const edited = anchor.slice(0, last.index) + value +
          anchor.slice(last.index + last[0].length);
        return text.replace(anchor, edited);
      };
      const gamePath = join(dir, "game/main.blot");
      const schemaPath = join(dir, "schema.ts");
      const scenePath = join(dir, "scenes/main.scene.json");
      const codeText = await Deno.readTextFile(gamePath);
      const schemaText = await Deno.readTextFile(schemaPath);
      const sceneText = await Deno.readTextFile(scenePath);
      const scene = JSON.parse(sceneText);
      const moved = scene.entities.find((
        e: { components: { transform?: unknown } },
      ) => e.components.transform);
      const live = (await world()).state.entities.find((e) =>
        e.components.transform
      )!;
      // Select an entity whose first inspector field takes a number.
      const rows = page.locator(".ink-tree .ink-row");
      let field = null;
      for (let i = 1; i < Math.min(8, await rows.count()) && !field; i++) {
        await rows.nth(i).click();
        await sleep(150);
        const index = await page.$$eval(
          ".ink-inspector input",
          (inputs) =>
            inputs.findIndex((e) => {
              const value = (e as HTMLInputElement).value;
              return value !== "" && !isNaN(Number(value));
            }),
        );
        if (index >= 0) field = page.locator(".ink-inspector input").nth(index);
      }
      for (let n = 1; n <= warmup + iterations; n++) {
        const measured = n > warmup;
        // Code
        let at = epochNow();
        await Deno.writeTextFile(gamePath, bump(codeText, edits.code, n));
        let trace = await next("code", at);
        if (measured) record("code", trace);
        await sleep(300);
        // Schema default
        if (edits.schema) {
          at = epochNow();
          await Deno.writeTextFile(
            schemaPath,
            bump(schemaText, edits.schema, n),
          );
          trace = await next("schema", at);
          if (measured) record("schema", trace);
          await sleep(300);
        }
        // Scene file
        at = epochNow();
        const original = moved.components.transform.position[0];
        moved.components.transform.position[0] = original + 0.01 * n;
        await Deno.writeTextFile(scenePath, JSON.stringify(scene, null, 2));
        moved.components.transform.position[0] = original;
        trace = await next("scene", at);
        if (measured) record("scene", trace);
        await sleep(300);
        // Component value through the live API (the inspector's path)
        const position = live.components.transform.position as number[];
        at = epochNow();
        await call("edit", {
          entity: live.id,
          component: "transform",
          values: {
            position: [position[0] + 0.01 * n, position[1], position[2]],
          },
        });
        trace = await next("tuning", at);
        if (measured) record("tuning", trace);
        await sleep(300);
        // The same value typed into an inspector field
        if (field) {
          at = epochNow();
          await field.fill(String(0.2 + 0.01 * n));
          await field.press("Enter");
          trace = await next("tuning", at);
          if (measured) record("inspector", trace);
          await sleep(300);
        }
        // A texture on disk (any trailing byte keeps the image valid)
        if (edits.asset) {
          at = epochNow();
          const path = join(dir, edits.asset);
          const bytes = await Deno.readFile(path);
          const edited = new Uint8Array(bytes.length + 1);
          edited.set(bytes);
          edited[bytes.length] = n;
          await Deno.writeFile(path, edited);
          trace = await next("asset", at);
          if (measured) record("asset", trace);
          await sleep(300);
        }
      }
      // The same tuning edits with the game paused: the GPU is idle, so the
      // change should reach the screen on the next frame.
      await call("play", { action: "pause" });
      await sleep(500);
      for (let n = 1; n <= warmup + Math.ceil(iterations / 2); n++) {
        const measured = n > warmup;
        const paused = (await world()).state.entities.find((e) =>
          e.components.transform
        )!;
        const position = paused.components.transform.position as number[];
        let at = epochNow();
        await call("edit", {
          entity: paused.id,
          component: "transform",
          values: {
            position: [position[0] + 0.01, position[1], position[2]],
          },
        });
        let trace = await next("tuning", at);
        if (measured) record("tuning (paused)", trace);
        await sleep(300);
        if (field) {
          at = epochNow();
          await field.fill(String(0.3 + 0.01 * n));
          await field.press("Enter");
          trace = await next("tuning", at);
          if (measured) record("inspector (paused)", trace);
          await sleep(300);
        }
        at = epochNow();
        moved.components.transform.position[0] += 0.02;
        await Deno.writeTextFile(scenePath, JSON.stringify(scene, null, 2));
        trace = await next("scene", at);
        if (measured) record("scene (paused)", trace);
        await sleep(300);
      }
      // The copied project is thrown away; restoring keeps re-runs clean.
      await Deno.writeTextFile(gamePath, codeText);
      await Deno.writeTextFile(schemaPath, schemaText);
      await Deno.writeTextFile(scenePath, sceneText);

      // The profiler panel, open, as the person sees it.
      await page.locator(".ink-profiler").click();
      await sleep(300);
      await page.screenshot({ path: `tmp/iteration-${name}-${suffix}.png` });
      const final = await profile();
      const entry: Record<string, unknown> = {
        frame: final.metrics,
        gpuTimestamps: final.gpuTimestamps,
      };
      console.log(`\n== ${name}`);
      for (const [label, s] of Object.entries(all)) {
        const median = percentile(s.totals, 0.5);
        const p95 = percentile(s.totals, 0.95);
        const stages: Record<string, number> = {};
        for (const [stage, list] of s.stages) {
          stages[stage] = Math.round(percentile(list, 0.5) * 10) / 10;
        }
        const line = Object.entries(stages).map(([k, v]) => `${k} ${v}`).join(
          ", ",
        );
        console.log(
          `${label.padEnd(7)} median ${median.toFixed(0)} ms, p95 ${
            p95.toFixed(0)
          } ms (n=${s.totals.length}${
            s.unchanged ? `, ${s.unchanged} unchanged` : ""
          }${s.failed ? `, ${s.failed} FAILED` : ""})\n        ${line}`,
        );
        entry[label] = {
          median,
          p95,
          samples: s.totals.length,
          unchanged: s.unchanged,
          failed: s.failed,
          stages,
          files: [...s.files],
          detail: s.detail,
        };
        const budget = BUDGET[label];
        if (assertBudgets && budget !== undefined && median > budget) {
          failures.push(
            `${name} ${label}: median ${median.toFixed(0)} ms > ${budget} ms`,
          );
        }
        if (s.failed > 0 && label !== "schema") {
          failures.push(`${name} ${label}: ${s.failed} traces never finished`);
        }
      }
      const f = final.metrics;
      console.log(
        `frame   step ${f.step.median.toFixed(2)} (guest ${
          f.guest.median.toFixed(2)
        }, decode ${f.decode.median.toFixed(2)}), extract ${
          f.extract.median.toFixed(2)
        }, render ${f.render.median.toFixed(2)}, gpu ${
          final.gpuTimestamps ? f.gpu.median.toFixed(2) : "n/a"
        }, interval ${f.frame.median.toFixed(1)} ms`,
      );
      report[name] = entry;
      if (errors.length) failures.push(`${name}: page errors ${errors[0]}`);
    } finally {
      await page.close().catch(() => {});
      await server.close();
    }
  }
} finally {
  await browser.close();
}
await Deno.mkdir("tmp", { recursive: true });
await Deno.writeTextFile(
  `tmp/iteration-report-${suffix}.json`,
  JSON.stringify(
    {
      adapter: adapterInfo,
      load: (await Deno.readTextFile("/proc/loadavg")).split(" ")[0],
      iterations,
      report,
    },
    null,
    2,
  ),
);
if (failures.length) {
  console.error("\n" + failures.join("\n"));
  Deno.exit(1);
}
console.log(
  `\niteration gate passed (${suffix}${assertBudgets ? "" : ", not asserted"})`,
);
