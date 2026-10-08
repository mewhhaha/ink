/** Browser pixel oracle plus a bounded, moving-camera lighting benchmark. */
import { assertEquals } from "@std/assert";
import { chromium } from "playwright-core";
import { findChromium, startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import type * as Render from "@ink/render";
import type * as Checks from "../packages/render/cluster_checks.ts";

type Result = {
  adapter: string;
  frames: Record<string, { median: number; p95: number }>;
};
type Job = {
  pending?: Promise<void>;
  result?: Result;
  error?: string;
  done?: boolean;
};
type Global = { clusterJob: Job };
const hardware = Deno.args.includes("--hardware");
const root = new URL("../", import.meta.url).pathname;
const project = await resolveProject("examples/godot");
project.config.vite = {
  plugins: [{
    name: "cluster-check-page",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/__cluster-checks") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(
          "<!doctype html><title>512 lights</title><style>body{margin:0;background:#111;color:#eee;font:18px sans-serif}p{position:absolute;left:20px;top:0}canvas{display:block}</style><p>512 point and spot lights</p><canvas width=1280 height=720></canvas>",
        );
      });
    },
  }],
};
const server = await startServer(project, { port: 0, quiet: true });
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
  const errors: string[] = [];
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const port = (server.httpServer!.address() as { port: number }).port;
  await page.goto(`http://127.0.0.1:${port}/__cluster-checks`);
  await page.evaluate(({ root, hardware, lowPower }) => {
    const job: Job = {};
    (globalThis as unknown as Global).clusterJob = job;
    job.pending = (async () => {
      const api = await import(
        `/@fs${root}packages/render/mod.ts`
      ) as typeof Render;
      const checks = await import(
        `/@fs${root}packages/render/cluster_checks.ts`
      ) as typeof Checks;
      const adapter = await navigator.gpu.requestAdapter({
        powerPreference: lowPower ? "low-power" : "high-performance",
      });
      if (!adapter) throw new Error("no WebGPU adapter");
      const info = adapter.info;
      const description =
        `${info.vendor} ${info.architecture} ${info.description}`;
      if (
        hardware &&
        (info.isFallbackAdapter ||
          /swiftshader|software|llvmpipe/i.test(description))
      ) throw new Error("hardware benchmark selected software");
      const device = await adapter.requestDevice();
      const renderer = await api.createRenderer({
        device,
        quality: hardware ? "high" : "low",
      });
      const validation: string[] = [];
      device.addEventListener(
        "uncapturederror",
        (e) => validation.push((e as GPUUncapturedErrorEvent).error.message),
      );
      try {
        await checks.checkClusters(renderer, hardware ? 1 : 0.5);
        const view = renderer.createView(document.querySelector("canvas")!);
        const scene = checks.clusterScene();
        const frames: Result["frames"] = {};
        if (hardware) {
          for (const mode of ["eight", "clustered", "reference"]) {
            const lights = scene.lights;
            if (mode === "eight") scene.lights = lights.slice(240, 248);
            const times: number[] = [];
            for (let i = 0; i < 70; i++) {
              const camera = api.lookAtCamera(
                [22 + Math.sin(i * 0.025), 38, 42],
                [0, 0, 0],
                { fov: 62, far: 180 },
                1280 / 720,
              );
              const start = performance.now();
              view.render(scene, camera, {
                still: true,
                clustered: mode !== "reference",
              });
              await device.queue.onSubmittedWorkDone();
              if (i >= 10) times.push(performance.now() - start);
            }
            times.sort((a, b) => a - b);
            frames[mode] = {
              median: times[Math.floor(times.length / 2)],
              p95: times[Math.floor(times.length * 0.95)],
            };
            scene.lights = lights;
          }
        }
        view.render(scene, checks.clusterCamera(1280 / 720), { still: true });
        await device.queue.onSubmittedWorkDone();
        if (validation.length) throw new Error(validation.join("\n"));
        job.result = { adapter: description, frames };
        // Preserve the canvas until Playwright captures the rendered frame.
      } catch (error) {
        renderer.dispose();
        device.destroy();
        throw error;
      }
    })().then(() => {
      job.done = true;
    }, (error) => {
      job.error = String(error);
      job.done = true;
    });
  }, { root, hardware, lowPower: Deno.args.includes("--low-power") });
  await page.waitForFunction(
    () => (globalThis as unknown as Global).clusterJob.done,
    undefined,
    { timeout: 180000 },
  );
  const result = await page.evaluate(() => {
    const job = (globalThis as unknown as Global).clusterJob;
    if (job.error) throw new Error(job.error);
    return job.result!;
  });
  await Deno.mkdir("tmp", { recursive: true });
  const suffix = hardware ? "hardware" : "software";
  await page.screenshot({ path: `tmp/clustered-${suffix}.png` });
  await Deno.writeTextFile(
    `tmp/clustered-${suffix}.json`,
    JSON.stringify(result, null, 2),
  );
  assertEquals(errors, []);
  console.log(JSON.stringify(result, null, 2));
  console.log(
    "✓ 512 point/spot lights, reference pixels, camera changes, overflow and still captures",
  );
} finally {
  await browser.close();
  await server.close();
}
