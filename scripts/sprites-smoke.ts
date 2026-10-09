/** The 2D layer on real GPU pixels in Chromium: crisp sprites, tile maps, text,
 * lights, shadows and depth beside 3D, temporal accumulation and picking. */
import { chromium } from "playwright-core";
import { findChromium, startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import { callAutomation } from "../packages/dev/browser.ts";
import type { Ink } from "../packages/react/context.tsx";
import type { InkAutomation } from "@ink/dev/automation";
import type * as Checks from "../packages/render/sprites_checks.ts";

type Job = {
  pending?: Promise<void>;
  done?: boolean;
  error?: string;
  pictures?: Record<string, { width: number; height: number; data: number[] }>;
};
type Global = {
  __ink: InkAutomation;
  spritesJob: Job;
  [key: symbol]: Promise<{ ink: Ink }>;
};
const root = new URL("../", import.meta.url).pathname;
const hardware = Deno.args.includes("--hardware");
const server = await startServer(await resolveProject("examples/tiles"), {
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
  const port = (server.httpServer!.address() as { port: number }).port;
  await page.goto(`http://127.0.0.1:${port}/?ink-automation`);
  await page.waitForFunction(() => "__ink" in globalThis);
  await callAutomation(page, "ready", undefined);
  await page.evaluate((root) => {
    const g = globalThis as unknown as Global;
    const job: Job = g.spritesJob = {};
    job.pending = (async () => {
      const { ink } = await g[Symbol.for("ink.boot")];
      const renderer = ink.renderer!;
      const validation: string[] = [];
      renderer.device.addEventListener(
        "uncapturederror",
        (e) => validation.push((e as GPUUncapturedErrorEvent).error.message),
      );
      const checks = await import(
        `/@fs${root}packages/render/sprites_checks.ts`
      ) as typeof Checks;
      const { pictures } = await checks.checkSprites(renderer);
      if (validation.length) throw new Error(validation.join("\n"));
      job.pictures = Object.fromEntries(
        Object.entries(pictures).map(([name, p]) => [
          name,
          { width: p.width, height: p.height, data: Array.from(p.data) },
        ]),
      );
    })().then(() => {
      job.done = true;
    }, (e) => {
      job.error = e.stack ?? String(e);
      job.done = true;
    });
  }, root);
  await page.waitForFunction(
    () => (globalThis as unknown as Global).spritesJob.done,
    undefined,
    { timeout: 180000 },
  );
  const job = await page.evaluate(() =>
    (globalThis as unknown as Global).spritesJob
  );
  if (job.error) throw new Error(job.error);
  if (errors.length) throw new Error(errors.join("\n"));
  await Deno.mkdir(`${root}tmp`, { recursive: true });
  const { encodePng } = await import("@ink/render");
  for (const [name, p] of Object.entries(job.pictures ?? {})) {
    // Magnify the 64 pixel pictures so they can be looked at.
    const scale = 6, w = p.width * scale, h = p.height * scale;
    const big = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const from = (Math.floor(y / scale) * p.width + Math.floor(x / scale)) *
          4;
        big.set(p.data.slice(from, from + 4), (y * w + x) * 4);
      }
    }
    await Deno.writeFile(
      `${root}tmp/sprites-${name}.png`,
      await encodePng(w, h, big) as Uint8Array,
    );
  }
  console.log(
    "2D layer ok: crisp sprites, atlas frames and flips, layers, tile maps, text, lights, normal maps, tile shadows, depth beside 3D, TAA, picking and hot reload",
  );
} finally {
  await browser.close();
  await server.close();
}
