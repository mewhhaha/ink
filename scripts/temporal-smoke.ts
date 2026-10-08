/** Motion, deformation, noise convergence, UI settings and real game upscaling. */
import { assertEquals } from "@std/assert";
import { chromium } from "playwright-core";
import { findChromium, startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import { callAutomation } from "../packages/dev/browser.ts";
import type { Ink } from "../packages/react/context.tsx";
import type { InkAutomation } from "@ink/dev/automation";
import type * as Render from "@ink/render";
import type * as Checks from "../packages/render/temporal_checks.ts";

type Job = {
  pending?: Promise<void>;
  done?: boolean;
  error?: string;
  pictures?: Record<string, string>;
  measurements?: Record<string, number>;
};
type Global = {
  __ink: InkAutomation;
  temporalJob: Job;
  viewportFrame?: { temporal: boolean; scale: number; count: number };
  [key: symbol]: Promise<{ ink: Ink }>;
};
const root = new URL("../", import.meta.url).pathname;
const hardware = Deno.args.includes("--hardware");
const server = await startServer(await resolveProject("examples/feel"), {
  port: 0,
  quiet: true,
});
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
    viewport: { width: 1100, height: 700 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.text().startsWith("temporal:") || m.type() === "error") {
      console.log(m.text());
    }
  });
  const port = (server.httpServer!.address() as { port: number }).port;
  await page.goto(`http://127.0.0.1:${port}/?ink-automation`);
  await page.waitForFunction(() => "__ink" in globalThis);
  await callAutomation(page, "ready", undefined);
  await page.evaluate(({ root, hardware }) => {
    const g = globalThis as unknown as Global, job: Job = g.temporalJob = {};
    job.pending = (async () => {
      const { ink } = await g[Symbol.for("ink.boot")], renderer = ink.renderer!;
      ink.loop.stop();
      await renderer.device.queue.onSubmittedWorkDone();
      const info = renderer.device.adapterInfo;
      console.log(
        `temporal: adapter ${info.vendor} ${info.architecture} ${info.description}`,
      );
      if (
        hardware &&
        (info.isFallbackAdapter ||
          /swiftshader|software|llvmpipe/i.test(info.description))
      ) {
        throw new Error("hardware check selected software");
      }
      const validation: string[] = [];
      renderer.device.addEventListener(
        "uncapturederror",
        (e) => validation.push((e as GPUUncapturedErrorEvent).error.message),
      );
      const api = await import(
        `/@fs${root}packages/render/mod.ts`
      ) as typeof Render;
      const checks = await import(
        `/@fs${root}packages/render/temporal_checks.ts`
      ) as typeof Checks;
      console.log("temporal: camera motion, depth rejection, seek, resize");
      const result = await checks.checkTemporal(renderer);
      console.log("temporal: skeletal and morph motion");
      const deformationError = await checks.checkTemporalDeformation(renderer);
      console.log("temporal: noise convergence");
      const noise = await checks.checkTemporalNoise(renderer);
      job.measurements = {
        halfError: result.halfError,
        motionError: result.motionError,
        deformationError,
        noiseVarianceRatio: noise.ratio,
      };
      const pictures: Record<string, string> = {};
      const save = async (name: string, pixels: Render.PixelData) => {
        const png = await api.encodePng(
          pixels.width,
          pixels.height,
          pixels.data,
        );
        let bytes = "";
        for (const byte of png) bytes += String.fromCharCode(byte);
        pictures[name] = btoa(bytes);
      };
      await save("reference", result.native);
      await save("half", result.half);
      await save("moving", result.moving);
      await save("grain-raw", noise.raw);
      await save("grain-accumulated", noise.accumulated);
      console.log("temporal: animated Feel Lab at half resolution");
      await g.__ink.run({ scene: "main", ticks: 0 });
      renderer.assets.preload("mesh", "models/runner.glb");
      await renderer.assets.settled();
      const s = ink.session,
        view = renderer.createView({ width: 480, height: 320 });
      s.play();
      try {
        for (let i = 0; i < 72; i++) {
          const input = s.input.sample(s.tick, s.dt, s.tick * s.dt);
          input.actions.move = i >= 40 ? 1 : 0;
          input.actions.jump = {
            down: i >= 60,
            pressed: i === 60,
            released: false,
          };
          s.stepFrame(input);
          if (i < 40) continue;
          const scene = ink.scene();
          const at = s.world.entities.find((e) => e.id === 2)!.components
            .transform.position as [number, number, number];
          const camera = api.lookAtCamera([at[0] + 2.2, at[1] + 0.7, 3.1], at, {
            fov: 32,
          }, 1.5);
          view.render(scene, camera, {
            temporal: true,
            renderScale: 0.5,
            quality: hardware ? "high" : "low",
            environment: { grain: 0, autoExposure: false },
          });
          await renderer.device.queue.onSubmittedWorkDone();
          if (i === 59 || i === 71) {
            await save(i === 59 ? "walk" : "jump", await view.readPixels());
          }
        }
        if (view.stats.temporalFrames < 8 || view.stats.renderWidth !== 240) {
          throw new Error("game pose changes reset the temporal history");
        }
        s.seek(60);
        const scene = ink.scene(), camera = api.gameCamera(scene, 1.5)!;
        view.render(scene, camera, { temporal: true, renderScale: 0.5 });
        if (Number(view.stats.temporalFrames) !== 1) {
          throw new Error("scrubbing retained history");
        }
        // Observe the real viewport's frames when its menu changes settings.
        const prototype = Object.getPrototypeOf(view) as Render.View;
        const render = prototype.render;
        prototype.render = function (scene, camera, overlays = {}) {
          render.call(this, scene, camera, overlays);
          g.viewportFrame = {
            temporal: !!overlays.temporal,
            scale: overlays.renderScale ?? 1,
            count: (g.viewportFrame?.count ?? 0) + 1,
          };
        };
      } finally {
        view.dispose();
      }
      if (validation.length) throw new Error(validation.join("\n"));
      job.pictures = pictures;
      ink.loop.start();
    })().then(() => {
      job.done = true;
    }, (e) => {
      job.error = e.stack ?? String(e);
      job.done = true;
    });
  }, { root, hardware });
  await page.waitForFunction(
    () => (globalThis as unknown as Global).temporalJob.done,
    undefined,
    { timeout: 180000 },
  );
  const result = await page.evaluate(() => {
    const job = (globalThis as unknown as Global).temporalJob;
    if (job.error) throw new Error(job.error);
    return { pictures: job.pictures!, measurements: job.measurements! };
  });
  const quality = page.getByRole("button", { name: /Image quality for/ })
    .first();
  await quality.click();
  await page.getByRole("button", { name: "50%", exact: true }).click();
  await page.waitForFunction(() =>
    (globalThis as unknown as Global).viewportFrame?.scale === 0.5
  );
  await quality.click();
  await page.getByRole("button", {
    name: "Temporal anti-aliasing: On",
    exact: true,
  }).click();
  await page.waitForFunction(() =>
    (globalThis as unknown as Global).viewportFrame?.temporal === false
  );
  await quality.click();
  await page.getByRole("button", {
    name: "Temporal anti-aliasing: Off",
    exact: true,
  }).click();
  await page.waitForFunction(() =>
    (globalThis as unknown as Global).viewportFrame?.temporal === true
  );
  const frames = await page.evaluate(() =>
    (globalThis as unknown as Global).viewportFrame!.count
  );
  await page.waitForFunction(
    (before) =>
      (globalThis as unknown as Global).viewportFrame!.count >= before + 8,
    frames,
    { timeout: 30000 },
  );
  assertEquals(errors, []);
  await Deno.mkdir("tmp", { recursive: true });
  const suffix = hardware ? "hardware" : "software";
  for (const [name, png] of Object.entries(result.pictures)) {
    await Deno.writeFile(
      `tmp/temporal-${name}-${suffix}.png`,
      Uint8Array.from(atob(png), (c) => c.charCodeAt(0)),
    );
  }
  await page.screenshot({ path: `tmp/temporal-editor-${suffix}.png` });
  console.log(
    "✓ temporal motion, deformation, disocclusion, resets, grain, real animation and viewport controls",
    result.measurements,
  );
} finally {
  await browser.close();
  await server.close();
}
