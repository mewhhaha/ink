/** Terrain and scatter in Chromium: the shared renderer checks on procedural
 * worlds (pictures under tmp/terrain-checks-*). Defaults to SwiftShader;
 * --hardware needs a real GPU, --headed shows the browser. */
import { chromium } from "playwright-core";
import { join } from "@std/path";
import { findChromium, startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import type { terrainChecks } from "../packages/render/terrain_checks.ts";
import type * as render from "../packages/render/mod.ts";

const root = new URL("../", import.meta.url).pathname;
const hardware = Deno.args.includes("--hardware");
const project = await resolveProject(join(root, "examples/terrain"));
project.config.vite = {
  ...project.config.vite,
  plugins: [{
    name: "terrain-check-page",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/__terrain-checks") return next();
        res.setHeader("Content-Type", "text/html");
        res.end("<!doctype html><title>Ink terrain checks</title>");
      });
    },
  }, ...(project.config.vite?.plugins ?? [])],
};
const server = await startServer(project, { port: 0, quiet: true });
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
let failed = 0;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/__terrain-checks`);
  // The first adapter request can fail while the GPU process starts.
  const adapter = await page.evaluate(async () => {
    for (let i = 0; i < 10; i++) {
      const a = await navigator.gpu?.requestAdapter();
      if (a) {
        return `${a.info.vendor} ${a.info.architecture} ${a.info.description}`;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return "";
  });
  if (!adapter) throw new Error("no WebGPU adapter");
  console.log(`WebGPU: ${adapter}`);
  const modules = {
    checks: `/@fs${root}packages/render/terrain_checks.ts`,
    render: `/@fs${root}packages/render/mod.ts`,
  };
  const names = await page.evaluate(async ({ checks }) => {
    const m = await import(checks) as { terrainChecks: typeof terrainChecks };
    return m.terrainChecks.map((c) => c.name);
  }, modules);
  await Deno.mkdir(join(root, "tmp"), { recursive: true });
  for (const [index, name] of names.entries()) {
    const started = performance.now();
    try {
      const result = await page.evaluate(async ({ modules, index }) => {
        const { terrainChecks: checks } = await import(modules.checks) as {
          terrainChecks: typeof terrainChecks;
        };
        const { createRenderer, encodePng } = await import(
          modules.render
        ) as typeof render;
        const renderer = await createRenderer();
        const problems: string[] = [];
        renderer.device.addEventListener("uncapturederror", (e) => {
          problems.push((e as GPUUncapturedErrorEvent).error.message);
        });
        try {
          const p = await checks[index].run(renderer);
          await renderer.device.queue.onSubmittedWorkDone();
          if (problems.length) throw new Error(problems.join("\n"));
          return {
            error: "",
            png: Array.from(await encodePng(p.width, p.height, p.data)),
          };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
            png: [],
          };
        } finally {
          renderer.dispose();
        }
      }, { modules, index });
      if (result.error) throw new Error(result.error);
      const path = join(
        root,
        "tmp",
        `terrain-checks-${hardware ? "hardware-" : ""}${index + 1}.png`,
      );
      await Deno.writeFile(path, new Uint8Array(result.png));
      console.log(
        `✓ ${name} (${Math.round(performance.now() - started)}ms) ${path}`,
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
  await browser.close();
  await server.close();
}
if (failed) Deno.exit(1);
