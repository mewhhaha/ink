/** Run renderer lifecycle regressions in Chromium, saving their final frames
 * for visual inspection. Defaults to SwiftShader; --hardware requires a real
 * GPU, and --headed shows the test browser on the desktop. */
import { chromium } from "playwright-core";
import { join } from "@std/path";
import { startServer } from "../packages/dev/cli.ts";
import { resolveProject } from "../packages/dev/node.ts";
import type { lifecycleChecks } from "../packages/render/lifecycle_checks.ts";
import type * as render from "../packages/render/mod.ts";

const root = new URL("../", import.meta.url).pathname;
const hardware = Deno.args.includes("--hardware");
const headed = Deno.args.includes("--headed");
const project = await resolveProject(join(root, "examples/godot"));
project.config.vite = {
  ...project.config.vite,
  plugins: [{
    name: "render-check-page",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/__render-checks") return next();
        res.setHeader("Content-Type", "text/html");
        res.end("<!doctype html><title>Ink renderer checks</title>");
      });
    },
  }, ...(project.config.vite?.plugins ?? [])],
};
const server = await startServer(project, { port: 0, quiet: true });
const address = server.httpServer!.address();
if (!address || typeof address === "string") throw new Error("no server port");
const chrome = Deno.env.get("INK_CHROMIUM") ??
  `${
    Deno.env.get("HOME")
  }/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
let browser;
let failed = 0;
try {
  browser = await chromium.launch({
    executablePath: chrome,
    headless: !headed,
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
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/__render-checks`);
  const adapter = await page.evaluate(async () => {
    const gpu = await navigator.gpu.requestAdapter();
    if (!gpu) throw new Error("no WebGPU adapter");
    const info = gpu.info;
    return {
      vendor: info.vendor,
      architecture: info.architecture,
      description: info.description,
      fallback: info.isFallbackAdapter,
    };
  });
  console.log(`WebGPU: ${JSON.stringify(adapter)}`);
  if (
    hardware && (adapter.fallback ||
      /swiftshader|llvmpipe|lavapipe|software|softpipe/i.test(
        `${adapter.vendor} ${adapter.architecture} ${adapter.description}`,
      ))
  ) throw new Error("--hardware selected a software adapter");
  const modules = {
    checks: `/@fs${root}packages/render/lifecycle_checks.ts`,
    render: `/@fs${root}packages/render/mod.ts`,
  };
  const names = await page.evaluate(async ({ checks }) => {
    const module = await import(checks) as {
      lifecycleChecks: typeof lifecycleChecks;
    };
    return module.lifecycleChecks.map((check) => check.name);
  }, modules);
  await Deno.mkdir(join(root, "tmp"), { recursive: true });
  for (const [index, name] of names.entries()) {
    const started = performance.now();
    try {
      const result = await page.evaluate(async ({ modules, index }) => {
        const { lifecycleChecks: checks } = await import(modules.checks) as {
          lifecycleChecks: typeof lifecycleChecks;
        };
        const { createRenderer, encodePng } = await import(
          modules.render
        ) as typeof render;
        const renderer = await createRenderer();
        const errors: string[] = [];
        renderer.device.addEventListener("uncapturederror", (event) => {
          errors.push((event as GPUUncapturedErrorEvent).error.message);
        });
        const png = async (pixels: render.PixelData) =>
          Array.from(
            await encodePng(pixels.width, pixels.height, pixels.data),
          );
        try {
          const pixels = await checks[index].run(renderer);
          await renderer.device.queue.onSubmittedWorkDone();
          if (errors.length) throw new Error(errors.join("\n"));
          return { error: "", frames: [await png(pixels)] };
        } catch (error) {
          const frames = (error as { frames?: render.PixelData[] }).frames ??
            [];
          return {
            error: error instanceof Error ? error.message : String(error),
            frames: await Promise.all(frames.map(png)),
          };
        } finally {
          renderer.dispose();
        }
      }, { modules, index });
      const path = join(
        root,
        "tmp",
        `render-lifecycle-${hardware ? "hardware-" : ""}${index + 1}`,
      );
      for (const [frame, bytes] of result.frames.entries()) {
        const suffix = result.error ? `-failure-${frame + 1}` : "";
        await Deno.writeFile(`${path}${suffix}.png`, new Uint8Array(bytes));
      }
      if (result.error) throw new Error(result.error);
      console.log(
        `✓ ${name} (${Math.round(performance.now() - started)}ms) ${path}.png`,
      );
    } catch (error) {
      failed++;
      console.error(
        `✗ ${name}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  if (errors.length) console.error(errors.join("\n"));
  failed += errors.length;
} finally {
  await browser?.close();
  await server.close();
}
if (failed) Deno.exit(1);
