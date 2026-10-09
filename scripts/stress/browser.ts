/** The stress project in Chromium: the real frame loop, React panels and
 * renderer around the same session `world-bench.ts` measures in Deno. */
import { chromium } from "playwright-core";
import { findChromium, startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import { callAutomation } from "../../packages/dev/browser.ts";
import type { Ink } from "../../packages/react/context.tsx";
import type { InkAutomation } from "@ink/dev/automation";
import type * as Render from "@ink/render";
import type * as World from "./world.ts";
import type * as Core from "@ink/core";

export interface Spread {
  median: number;
  p95: number;
  min: number;
}

export interface BrowserResult {
  adapter: string;
  count: number;
  movers: number;
  loadMs: number;
  /** One fixed step through the session: guest call and packet handling. */
  step: Spread;
  /** Scene extraction after each step. */
  extract: Spread;
  /** Submitting a 1280 x 720 frame, and until the GPU finished it. */
  renderCpu: Spread;
  renderComplete: Spread;
  /** The panels' response to a changed world: listeners and React. */
  panels: Spread;
  /** The real loop with every panel mounted, steps per second included. */
  loop: {
    seconds: number;
    steps: number;
    stepsPerSecond: number;
    frames: number;
    frameMs: Spread;
    /** Longest main-thread frame work the browser reported. */
    longestFrameWork: number;
  };
  rewindMs: number;
  /** Hash of the state after 40 fresh ticks, to compare with the headless run. */
  hash40: string;
  errors: string[];
}

interface Global {
  __ink: InkAutomation;
  stressJob: { done?: boolean; error?: string; result?: BrowserResult[] };
  [key: symbol]: Promise<{ ink: Ink }>;
}

const root = new URL("../../", import.meta.url).pathname;

export async function measureBrowser(options: {
  /** World sizes, and how many of each one's entities move. */
  cases: { count: number; movers: number }[];
  frames: number;
  hardware: boolean;
  headed: boolean;
}): Promise<BrowserResult[]> {
  const server = await startServer(await resolveProject("scripts/stress"), {
    port: 0,
    quiet: true,
  });
  const browser = await chromium.launch({
    executablePath: await findChromium(),
    headless: !options.headed,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      ...(options.hardware
        ? ["--use-angle=vulkan", "--disable-vulkan-surface"]
        : [
          "--use-vulkan=swiftshader",
          "--use-webgpu-adapter=swiftshader",
          "--use-angle=swiftshader",
          "--enable-unsafe-swiftshader",
        ]),
    ],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const port = (server.httpServer!.address() as { port: number }).port;
    await page.goto(`http://127.0.0.1:${port}/?ink-automation`);
    await page.waitForFunction(() => "__ink" in globalThis);
    await callAutomation(page, "ready", undefined);
    await page.evaluate(({ root, options }) => {
      const g = globalThis as unknown as Global;
      const job: Global["stressJob"] = g.stressJob = {};
      const spread = (times: number[]): Spread => {
        const s = [...times].sort((a, b) => a - b);
        const at = (q: number) =>
          s[Math.min(s.length - 1, Math.floor(s.length * q))];
        return {
          median: +at(0.5).toFixed(3),
          p95: +at(0.95).toFixed(3),
          min: +s[0].toFixed(3),
        };
      };
      void (async () => {
        const { ink } = await g[Symbol.for("ink.boot")];
        const renderer = ink.renderer!;
        const api = await import(
          `/@fs${root}packages/render/mod.ts`
        ) as typeof Render;
        const world = await import(
          `/@fs${root}scripts/stress/world.ts`
        ) as typeof World;
        const session = ink.session;
        const info = renderer.device.adapterInfo;
        const adapter =
          `${info.vendor} ${info.architecture} ${info.description}`;
        if (
          options.hardware &&
          (info.isFallbackAdapter ||
            /swiftshader|software|llvmpipe/i.test(info.description))
        ) {
          throw new Error("hardware run selected a software adapter");
        }
        const core = await import(
          `/@fs${root}packages/core/mod.ts`
        ) as typeof Core;
        const results: BrowserResult[] = [];
        const view = renderer.createView({ width: 1280, height: 720 });
        const longFrames: number[] = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) longFrames.push(e.duration);
        }).observe({ type: "long-animation-frame", buffered: false });
        for (const { count, movers } of options.cases) {
          ink.loop.stop();
          session.stop();
          let t = performance.now();
          session.loadScene(world.stressScene(count, movers), "stress");
          session.play();
          const loadMs = +(performance.now() - t).toFixed(1);
          // Let React finish mounting the big outliner before measuring.
          await new Promise((r) => setTimeout(r, 300));

          const step: number[] = [], extract: number[] = [];
          const renderCpu: number[] = [], renderComplete: number[] = [];
          const panels: number[] = [];
          for (let i = 0; i < options.frames + 3; i++) {
            t = performance.now();
            session.stepFrame();
            const stepped = performance.now() - t;
            t = performance.now();
            const scene = ink.scene();
            const extracted = performance.now() - t;
            // React runs its updates after the step; wait for them to flush.
            t = performance.now();
            await new Promise<void>((r) => queueMicrotask(r));
            const flushed = performance.now() - t;
            let cpu = 0, complete = 0;
            const draws = options.hardware
              ? i % 5 === 0
              : count <= 2000 && i === 3;
            if (draws) {
              const camera = api.gameCamera(scene, 1280 / 720)!;
              t = performance.now();
              view.render(scene, camera, { temporal: false });
              cpu = performance.now() - t;
              await renderer.device.queue.onSubmittedWorkDone();
              complete = performance.now() - t;
            }
            if (i >= 3) {
              step.push(stepped);
              extract.push(extracted);
              panels.push(flushed);
              if (draws) {
                renderCpu.push(cpu);
                renderComplete.push(complete);
              }
            }
          }
          const tickBeforeRewind = session.tick;
          t = performance.now();
          session.seek(Math.max(0, tickBeforeRewind - 45));
          const rewindMs = +(performance.now() - t).toFixed(1);

          // The real frame loop, panels and viewport included. A software
          // adapter would only measure itself, so this needs hardware.
          let seconds = 0, gaps: number[] = [], steps = 0;
          session.seek(tickBeforeRewind);
          if (options.hardware) {
            session.resume();
            longFrames.length = 0;
            const stamps: number[] = [];
            const tick0 = session.tick;
            const started = performance.now();
            ink.loop.start();
            await new Promise<void>((resolve) => {
              const sample = (now: number) => {
                stamps.push(now);
                if (now - started < 4000) requestAnimationFrame(sample);
                else resolve();
              };
              requestAnimationFrame(sample);
            });
            ink.loop.stop();
            steps = session.tick - tick0;
            seconds = (performance.now() - started) / 1000;
            gaps = stamps.slice(1).map((v, i) => v - stamps[i]);
          }
          session.stop();
          session.loadScene(world.stressScene(count, movers), "stress");
          session.play();
          session.pause();
          for (let i = 0; i < 40; i++) session.stepFrame();
          const hash40 = core.stateHash(session.state);
          results.push({
            adapter,
            count,
            movers,
            loadMs,
            step: spread(step),
            extract: spread(extract),
            renderCpu: spread(renderCpu.length ? renderCpu : [0]),
            renderComplete: spread(
              renderComplete.length ? renderComplete : [0],
            ),
            panels: spread(panels),
            loop: {
              seconds: +seconds.toFixed(2),
              steps,
              stepsPerSecond: seconds ? +(steps / seconds).toFixed(1) : 0,
              frames: gaps.length,
              frameMs: spread(gaps.length ? gaps : [0]),
              longestFrameWork: +Math.max(0, ...longFrames).toFixed(1),
            },
            rewindMs,
            hash40,
            errors: [],
          });
        }
        view.dispose();
        job.result = results;
      })().then(() => {
        job.done = true;
      }, (e) => {
        job.error = e.stack ?? String(e);
        job.done = true;
      });
    }, { root, options });
    await page.waitForFunction(
      () => (globalThis as unknown as Global).stressJob.done,
      undefined,
      { timeout: 20 * 60 * 1000, polling: 500 },
    );
    const outcome = await page.evaluate(() => {
      const job = (globalThis as unknown as Global).stressJob;
      if (job.error) throw new Error(job.error);
      return job.result!;
    });
    for (const result of outcome) result.errors = errors;
    return outcome;
  } finally {
    await browser.close();
    await server.close();
  }
}
