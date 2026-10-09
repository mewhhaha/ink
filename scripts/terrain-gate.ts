/**
 * The large-world gate: a 4.2 km² terrain with more than 100,000 instances
 * must edit and play smoothly. Opens `examples/terrain` in Chromium and
 * measures, over real frames:
 *
 *   fly     the camera circling the terrain at 40..160 m, offscreen 1280x720
 *   play    the walker running across the terrain (step + extract + render)
 *   sculpt  a raise stroke and a paint stroke dragged with the real mouse on
 *           the editor viewport (frame intervals while the pointer is down),
 *           then undo and a check that the data came back exactly
 *
 * Pictures go to tmp/terrain-gate-*.png. Defaults to SwiftShader (fewer frames,
 * smaller size, no timing gate); --hardware measures on the GPU.
 *
 *   deno task test:terrain -- --hardware [--headed] [--frames N]
 */
import { chromium } from "playwright-core";
import { decode as decodePng } from "fast-png";
import { join } from "@std/path";
import { findChromium, startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import type { Ink } from "../packages/react/context.tsx";
import type * as Render from "../packages/render/mod.ts";
import type * as Geometry from "../packages/geometry/mod.ts";

const root = new URL("../", import.meta.url).pathname;
const hardware = Deno.args.includes("--hardware");
const frames = Number(
  Deno.args.find((a) => a.startsWith("--frames="))?.split("=")[1] ??
    (hardware ? 300 : 3),
);
type Stats = { median: number; p95: number; max: number; count: number };
type Report = {
  adapter: string;
  fly: Stats & { cpuMedian: number };
  play: Stats;
  sculpt: Stats & { strokes: number; ms: number };
  paint: Stats;
  pictures: Record<string, string>;
  terrain: Record<string, number | string>;
  scatter: { entity: number; resident: number; kept: number[] }[];
  checks: string[];
};
type Global = {
  gate?: { done?: boolean; error?: string; report?: Partial<Report> };
  [key: symbol]: Promise<{ ink: Ink }>;
};

const server = await startServer(
  await resolveProject(join(root, "examples/terrain")),
  { port: 0, quiet: true },
);
const port = (server.httpServer!.address() as { port: number }).port;
const browser = await chromium.launch({
  executablePath: await findChromium(),
  headless: !Deno.args.includes("--headed"),
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    ...(hardware ? ["--use-angle=vulkan", "--disable-vulkan-surface"] : [
      "--use-vulkan=swiftshader",
      "--use-webgpu-adapter=swiftshader",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ]),
  ],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 850 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.text().startsWith("gate:")) console.log(m.text());
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(
    () => Symbol.for("ink.boot") in globalThis,
    undefined,
    { timeout: 60000 },
  );
  // Stage 1: offscreen flights and play, inside the page.
  await page.evaluate(({ root, hardware, frames }) => {
    const g = globalThis as unknown as Global;
    const state: NonNullable<Global["gate"]> = g.gate = { report: {} };
    const stats = (values: number[]): Stats => {
      const sorted = [...values].sort((a, b) => a - b);
      const at = (p: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      return {
        median: at(0.5),
        p95: at(0.95),
        max: sorted[sorted.length - 1],
        count: sorted.length,
      };
    };
    (async () => {
      const boot = await g[Symbol.for("ink.boot")];
      for (let i = 0; i < 300 && !boot.ink.renderer; i++) {
        await new Promise((r) => setTimeout(r, 200));
      }
      // The boot record swaps in a new `ink` once the renderer exists.
      const ink = boot.ink;
      if (!ink.renderer) {
        throw new Error(
          `no renderer: ${
            JSON.stringify(ink.session.log.slice(-4).map((l) => l.text))
          }`,
        );
      }
      const renderer = ink.renderer;
      const api = await import(
        `/@fs${root}packages/render/mod.ts`
      ) as typeof Render;
      const report = state.report!;
      const info = renderer.device.adapterInfo;
      report.adapter = `${info.vendor} ${info.architecture} ${info.description}`
        .trim();
      if (
        hardware &&
        (info.isFallbackAdapter ||
          /swiftshader|software|llvmpipe/i.test(info.description))
      ) throw new Error("--hardware selected a software adapter");
      ink.loop.stop();
      const errors: string[] = [];
      renderer.device.addEventListener(
        "uncapturederror",
        (e) => errors.push((e as GPUUncapturedErrorEvent).error.message),
      );
      const width = hardware ? 1280 : 320, height = hardware ? 720 : 180;
      const view = renderer.createView({ width, height });
      const pictures: Record<string, string> = {};
      const save = async (name: string) => {
        const pixels = await view.readPixels();
        const png = await api.encodePng(width, height, pixels.data);
        let bytes = "";
        for (const b of png) bytes += String.fromCharCode(b);
        pictures[name] = btoa(bytes);
      };
      const scene0 = ink.scene();
      const terrain = scene0.terrains![0];
      const resource = renderer.assets.terrain(terrain.heightmap);
      // Wait for the file and the tile uploads (3 tiles a frame).
      for (let i = 0; i < 600 && resource.state !== "ready"; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (resource.state !== "ready") throw new Error("terrain did not load");
      await renderer.assets.settled();
      const first = api.gameCamera(scene0, width / height)!;
      for (let i = 0; i < (hardware ? 40 : 1); i++) {
        view.render(scene0, first, {
          quality: hardware ? "high" : "low",
          still: !hardware,
        });
        await renderer.device.queue.onSubmittedWorkDone();
      }
      console.log("gate: terrain streamed in, flying");

      // Fly.
      const options = {
        quality: hardware ? "high" as const : "low" as const,
        temporal: hardware,
      };
      const total: number[] = [], cpu: number[] = [];
      const center = resource.field!.cells / 2;
      void center;
      const player = scene0.matrices.get(
        ink.session.world.entities.find((e) => e.components.walker)!.id,
      )!;
      const at = [player[12], player[13], player[14]];
      const geometry = await import(
        `/@fs${root}packages/geometry/mod.ts`
      ) as typeof Geometry;
      const field = resource.field!;
      const ground = (x: number, z: number) =>
        terrain.position[1] + geometry.terrainHeightAt(
          field,
          {
            size: terrain.size,
            heightScale: terrain.heightScale,
            detail: terrain.detail,
          },
          x - terrain.position[0],
          z - terrain.position[2],
        );
      for (let i = 0; i < frames; i++) {
        const a = (i / frames) * Math.PI * 2;
        const radius = 260 + 120 * Math.sin(a * 2);
        const eye: [number, number, number] = [
          at[0] + Math.cos(a) * radius,
          at[1] + 60 + 50 * Math.sin(a * 3),
          at[2] + Math.sin(a) * radius,
        ];
        // Never inside a hill: the ground there is culled from underneath.
        eye[1] = Math.max(eye[1], ground(eye[0], eye[2]) + 12);
        const camera = api.lookAtCamera(
          eye,
          [at[0], at[1] + 10, at[2]],
          { far: 6000, fov: 60 },
          width / height,
        );
        const t = performance.now();
        view.render(scene0, camera, options);
        const c = performance.now();
        await renderer.device.queue.onSubmittedWorkDone();
        total.push(performance.now() - t);
        cpu.push(c - t);
        if (i === Math.floor(frames / 4) || i === Math.floor(frames * 3 / 4)) {
          await save(i < frames / 2 ? "fly-1" : "fly-2");
        }
      }
      report.fly = { ...stats(total), cpuMedian: stats(cpu).median };
      console.log(
        `gate: slowest fly frames ${
          JSON.stringify(
            total.map((t, i) => [i, Math.round(t), Math.round(cpu[i])]).sort((
              a,
              b,
            ) => b[1] - a[1]).slice(0, 12),
          )
        }`,
      );
      // A ground-level view (grass, rocks and trees at their largest).
      view.render(
        scene0,
        api.lookAtCamera(
          [at[0] + 4, at[1] + 3, at[2] + 9],
          [at[0] - 6, at[1] + 4, at[2] - 30],
          { far: 6000 },
          width / height,
        ),
        { quality: hardware ? "high" : "low", still: true },
      );
      await save("ground");
      report.scatter = (await view.scatterCounts!()).map((l) => ({
        entity: l.entity,
        resident: l.resident,
        kept: l.counts[0],
      }));
      if (!hardware) {
        // SwiftShader draws this scene in seconds per frame: it checks that
        // the real scene renders without GPU errors, nothing more.
        report.checks = ["software adapter: pictures only"];
        report.pictures = pictures;
        if (errors.length) throw new Error(errors.join("\n"));
        view.dispose();
        ink.loop.start();
        return;
      }
      console.log("gate: playing");

      // Play: the walker runs north across the terrain.
      const s = ink.session;
      s.play();
      const play: number[] = [];
      const start = s.world.entities.find((e) => e.components.walker)!
        .components.transform.position as number[];
      for (let i = 0; i < frames; i++) {
        const t = performance.now();
        const input = s.input.sample(s.tick, s.dt, s.tick * s.dt);
        input.actions.move = [0.4, 1];
        input.actions.run = { down: true, pressed: false, released: false };
        s.stepFrame(input);
        const scene = ink.scene();
        const camera = api.gameCamera(scene, width / height)!;
        view.render(scene, camera, options);
        await renderer.device.queue.onSubmittedWorkDone();
        play.push(performance.now() - t);
        if (i === Math.floor(frames / 2)) await save("play");
      }
      const end = s.world.entities.find((e) => e.components.walker)!
        .components;
      const position = end.transform.position as number[];
      report.play = stats(play);
      report.checks = [
        `walker ran ${
          Math.hypot(position[0] - start[0], position[2] - start[2]).toFixed(1)
        } m, grounded ${end.walker.grounded}`,
      ];
      s.stop();
      if (errors.length) throw new Error(errors.join("\n"));
      report.pictures = pictures;
      view.dispose();
      ink.loop.start();
    })().then(() => {
      state.done = true;
    }, (e) => {
      state.error = e.stack ?? String(e);
      state.done = true;
    });
  }, { root, hardware, frames });
  await page.waitForFunction(
    () => (globalThis as unknown as Global).gate?.done,
    undefined,
    { timeout: 900000, polling: 1000 },
  );
  const stage1 = await page.evaluate(() => {
    const gate = (globalThis as unknown as Global).gate!;
    if (gate.error) throw new Error(gate.error);
    return gate.report!;
  }) as Report;

  if (!hardware) {
    await Deno.mkdir(join(root, "tmp"), { recursive: true });
    for (const [name, png] of Object.entries(stage1.pictures)) {
      await Deno.writeFile(
        join(root, `tmp/terrain-gate-${name}-software.png`),
        Uint8Array.from(atob(png), (c) => c.charCodeAt(0)),
      );
    }
    console.log(
      `adapter: ${stage1.adapter}\nfly: ${
        stage1.fly.median.toFixed(0)
      } ms/frame (software, ${stage1.fly.count} frames, pictures only)`,
    );
    console.log(
      "✓ the real scene renders on the software adapter without GPU errors",
    );
    Deno.exit(0);
  }
  // Stage 2: sculpt and paint with the real mouse on the editor viewport.
  await page.getByText("Terrain", { exact: true }).first().click();
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __raf: number[];
      __rafOn: boolean;
    };
    w.__raf = [];
    w.__rafOn = false;
    const tick = (t: number) => {
      if (w.__rafOn) w.__raf.push(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const snapshot = () =>
    page.evaluate(async () => {
      const g = globalThis as unknown as Global;
      const ink = (await g[Symbol.for("ink.boot")]).ink;
      const scene = ink.scene();
      const resource = ink.renderer!.assets.terrain(
        scene.terrains![0].heightmap,
      );
      const field = resource.field!;
      let sum = 0, splat = 0;
      for (let i = 0; i < field.heights.length; i += 7) sum += field.heights[i];
      for (let i = 0; i < field.splat.length; i += 5) splat += field.splat[i];
      return {
        revision: resource.revision,
        sum,
        splat,
        history: ink.session.history().undo.length,
      };
    });
  // The live viewports, as the editor draws them (a headless screenshot of a
  // WebGPU canvas can come back black, so ask the views themselves).
  const captureRaw = () =>
    page.evaluate(async () => {
      const g = globalThis as unknown as Global;
      const ink = (await g[Symbol.for("ink.boot")]).ink;
      const out: Record<string, { png: string; deviation: number }> = {};
      for (const [id, handle] of ink.views) {
        const png = await handle.capture();
        out[id] = {
          png: png.slice(png.indexOf(",") + 1),
          deviation: 0,
        };
      }
      return out;
    });
  /** The live views as PNGs, with the spread of their grey levels (decoded
   * here: reading a canvas back in the page is unreliable in headed mode). */
  const captureViews = async () => {
    const raw = await captureRaw();
    for (const v of Object.values(raw)) {
      const image = decodePng(
        Uint8Array.from(atob(v.png), (c) => c.charCodeAt(0)),
      );
      const channels = image.channels;
      let sum = 0, squares = 0;
      const n = image.width * image.height;
      for (let i = 0; i < n; i++) {
        const grey = (image.data[i * channels] + image.data[i * channels + 1] +
          image.data[i * channels + 2]) / 3;
        sum += grey;
        squares += grey * grey;
      }
      const mean = sum / n;
      v.deviation = Math.sqrt(Math.max(0, squares / n - mean * mean));
    }
    return raw;
  };
  const saveViews = async (tag: string) => {
    for (const [id, v] of Object.entries(await captureViews())) {
      await Deno.writeFile(
        join(root, `tmp/terrain-gate-${tag}-${id}.png`),
        Uint8Array.from(atob(v.png), (c) => c.charCodeAt(0)),
      );
    }
  };
  await saveViews("start");
  const canvas = page.locator("canvas").first();
  const box = (await canvas.boundingBox())!;
  const drag = async (name: string, from: number[], to: number[]) => {
    await page.getByRole("button", { name }).first().click();
    await page.evaluate(() => {
      const w = globalThis as unknown as { __raf: number[]; __rafOn: boolean };
      w.__raf = [];
      w.__rafOn = true;
    });
    const x0 = box.x + box.width * from[0], y0 = box.y + box.height * from[1];
    const x1 = box.x + box.width * to[0], y1 = box.y + box.height * to[1];
    const started = performance.now();
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    const steps = hardware ? 120 : 4;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(
        x0 + (x1 - x0) * i / steps,
        y0 + (y1 - y0) * i / steps,
      );
      if (hardware) await page.waitForTimeout(8);
    }
    await page.mouse.up();
    const ms = performance.now() - started;
    const times = await page.evaluate(() => {
      const w = globalThis as unknown as { __raf: number[]; __rafOn: boolean };
      w.__rafOn = false;
      return w.__raf.slice();
    });
    const intervals = times.slice(1).map((t, i) => t - times[i]);
    return { intervals, ms };
  };
  const summary = (values: number[]): Stats => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    return {
      median: at(0.5),
      p95: at(0.95),
      max: sorted[sorted.length - 1] ?? 0,
      count: sorted.length,
    };
  };
  await page.waitForTimeout(1500);
  const before = await snapshot();
  const raise = await drag("Raise ground", [0.35, 0.65], [0.7, 0.55]);
  await page.waitForTimeout(500);
  await saveViews("raised");
  const raised = await snapshot();
  // Paint with the dirt layer, so the stroke changes a meadow of grass.
  await page.getByTestId("terrain-layer-2").click();
  const paint = await drag("Paint layer", [0.3, 0.75], [0.75, 0.7]);
  await page.waitForTimeout(500);
  await saveViews("painted");
  const painted = await snapshot();
  const checks = [...stage1.checks];
  if (!(raised.revision > before.revision && raised.sum > before.sum)) {
    throw new Error(`the raise stroke did nothing: ${JSON.stringify(raised)}`);
  }
  if (!(painted.revision > raised.revision && painted.splat !== raised.splat)) {
    throw new Error(`the paint stroke did nothing: ${JSON.stringify(painted)}`);
  }
  checks.push(
    `raise: revision ${before.revision}->${raised.revision}, history ${before.history}->${raised.history}`,
    `paint: revision ${raised.revision}->${painted.revision}`,
  );
  let views = await captureViews();
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (["main", "game"].every((id) => (views[id]?.deviation ?? 0) >= 12)) {
      break;
    }
    console.log(
      `gate: a viewport capture was empty (attempt ${attempt}): ${
        JSON.stringify(
          Object.fromEntries(
            Object.entries(views).map(([id, v]) => [id, v.deviation]),
          ),
        )
      }`,
    );
    await page.waitForTimeout(700);
    views = await captureViews();
  }
  for (const id of ["main", "game"]) {
    const view = views[id];
    if (!view || view.deviation < 12) {
      throw new Error(
        `the ${id} viewport is empty (deviation ${view?.deviation})`,
      );
    }
    await Deno.writeFile(
      join(root, `tmp/terrain-gate-view-${id}.png`),
      Uint8Array.from(atob(view.png), (c) => c.charCodeAt(0)),
    );
    checks.push(
      `the ${id} viewport shows the world (deviation ${
        view.deviation.toFixed(0)
      })`,
    );
  }
  // A headless screenshot of WebGPU canvases can come back black; headed
  // shows the real window.
  if (Deno.args.includes("--headed")) {
    await page.screenshot({ path: join(root, "tmp/terrain-gate-editor.png") });
  }
  // Undo both strokes: the data comes back exactly, the save follows.
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
  }
  const undone = await snapshot();
  if (
    undone.revision !== before.revision || undone.sum !== before.sum ||
    undone.splat !== before.splat
  ) {
    throw new Error(
      `undo did not restore the terrain: ${JSON.stringify({ before, undone })}`,
    );
  }
  checks.push("undo restored the heights and splat exactly");
  await page.waitForTimeout(1500);
  const saved = await page.evaluate(async () => {
    const response = await fetch("/__ink/assets/terrain/world.terrain", {
      headers: { Range: "bytes=0-31" },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return new DataView(bytes.buffer).getUint32(20, true);
  });
  checks.push(`file revision after undo: ${saved}`);
  if (errors.length) throw new Error(errors.join("\n"));

  await Deno.mkdir(join(root, "tmp"), { recursive: true });
  const suffix = hardware ? "hardware" : "software";
  for (const [name, png] of Object.entries(stage1.pictures)) {
    await Deno.writeFile(
      join(root, `tmp/terrain-gate-${name}-${suffix}.png`),
      Uint8Array.from(atob(png), (c) => c.charCodeAt(0)),
    );
  }
  const fmt = (s: Stats) =>
    `median ${s.median.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms, max ${
      s.max.toFixed(1)
    } ms (${s.count} frames)`;
  console.log(`adapter: ${stage1.adapter}`);
  console.log(
    `fly:    ${fmt(stage1.fly)}; cpu median ${
      stage1.fly.cpuMedian.toFixed(2)
    } ms`,
  );
  console.log(`play:   ${fmt(stage1.play)}`);
  console.log(
    `sculpt: ${fmt(summary(raise.intervals))} editor frame intervals`,
  );
  console.log(
    `paint:  ${fmt(summary(paint.intervals))} editor frame intervals`,
  );
  console.log(
    `instances: ${
      stage1.scatter.map((l) =>
        `#${l.entity} resident ${l.resident} drawn ${
          l.kept.reduce((a, b) => a + b, 0)
        }`
      ).join(", ")
    }`,
  );
  for (const c of checks) console.log(`✓ ${c}`);
  const gate = hardware && stage1.fly.p95 > 33.4;
  if (gate) throw new Error(`fly p95 ${stage1.fly.p95} ms exceeds 33 ms`);
} finally {
  await browser.close();
  await server.close();
}
