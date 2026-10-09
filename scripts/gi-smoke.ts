/** GPU bounce lighting/reflections plus live Hammer edits and undo. */
import { assertEquals } from "@std/assert";
import { chromium } from "playwright-core";
import { findChromium, startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import { callAutomation } from "../packages/dev/browser.ts";
import type { Ink } from "../packages/react/context.tsx";
import type { InkAutomation } from "@ink/dev/automation";
import type * as Render from "@ink/render";
import type * as Checks from "../packages/render/gi_checks.ts";

type Job = {
  pending?: Promise<void>;
  done?: boolean;
  error?: string;
  pictures?: Record<string, string>;
  measurements?: Record<string, number>;
};
type Global = {
  __ink: InkAutomation;
  giJob: Job;
  [key: symbol]: Promise<{ ink: Ink }>;
};
const root = new URL("../", import.meta.url).pathname;
const hardware = Deno.args.includes("--hardware");
const server = await startServer(await resolveProject("examples/hammer"), {
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
    viewport: { width: 1100, height: 750 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error(e.stack ?? e.message);
  });
  page.on("console", (m) => {
    if (m.text().startsWith("gi:") || m.type() === "error") {
      console.log(m.text());
    }
  });
  const port = (server.httpServer!.address() as { port: number }).port;
  await page.goto(`http://127.0.0.1:${port}/?ink-automation`);
  await page.waitForFunction(() => "__ink" in globalThis).catch(
    async (error) => {
      throw new Error(
        `${page.url()}\n${await page.locator("body").innerText()}`,
        {
          cause: error,
        },
      );
    },
  );
  await callAutomation(page, "ready", undefined);
  await page.evaluate(({ root, hardware }) => {
    const g = globalThis as unknown as Global, job: Job = g.giJob = {};
    job.pending = (async () => {
      const { ink } = await g[Symbol.for("ink.boot")],
        renderer = ink.renderer!,
        s = ink.session;
      ink.loop.stop();
      await renderer.device.queue.onSubmittedWorkDone();
      const info = renderer.device.adapterInfo;
      console.log(
        `gi: adapter ${info.vendor} ${info.architecture} ${info.description}`,
      );
      if (
        hardware &&
        (info.isFallbackAdapter ||
          /swiftshader|software|llvmpipe/i.test(info.description))
      ) throw new Error("hardware check selected software");
      const validation: string[] = [];
      renderer.device.addEventListener(
        "uncapturederror",
        (e) => validation.push((e as GPUUncapturedErrorEvent).error.message),
      );
      const api = await import(
        `/@fs${root}packages/render/mod.ts`
      ) as typeof Render;
      const checks = await import(
        `/@fs${root}packages/render/gi_checks.ts`
      ) as typeof Checks;
      console.log(
        "gi: shadowed room, incremental bake, deterministic edit/undo",
      );
      const result = await checks.checkGi(renderer);
      console.log("gi: dynamic SSR and box-projected static probes");
      const reflections = await checks.checkReflections(renderer);
      const pictures: Record<string, string> = job.pictures = {};
      const save = async (name: string, p: Render.PixelData) => {
        const png = await api.encodePng(p.width, p.height, p.data);
        let bytes = "";
        for (const b of png) bytes += String.fromCharCode(b);
        pictures[name] = btoa(bytes);
      };
      for (
        const [name, p] of Object.entries({
          direct: result.direct,
          baked: result.baked,
          edited: result.edited,
          ssr: reflections.reflected,
          moved: reflections.moved,
          probe: reflections.probe,
        })
      ) await save(name, p);
      console.log("gi: Hammer lamp bounce and live brush edit");
      await g.__ink.run({ scene: "main", ticks: 0 });
      s.stop();
      const byName = (name: string) =>
        s.world.entities.find((e) => s.names.get(e.id) === name)!;
      for (const name of ["lamp1", "lamp2", "lamp3", "lamp4"]) {
        s.setComponent(byName(name).id, "light", {
          ...byName(name).components.light,
          intensity: name === "lamp2" ? 6 : 0,
        });
      }
      const view = renderer.createView({ width: 480, height: 320 });
      const camera = api.lookAtCamera([-4, 2.2, -7], [-2.5, 1.1, -12], {
        fov: 62,
        far: 50,
      }, 1.5);
      const render = (still: boolean, indirect = 1) =>
        view.render(ink.scene(), camera, {
          still,
          quality: hardware ? "high" : "low",
          environment: {
            indirect,
            reflections: 1,
            ambient: 0,
            grain: 0,
            autoExposure: false,
          },
        });
      try {
        render(true, 0);
        await renderer.assets.settled();
        render(true, 0);
        const direct = await view.readPixels();
        render(true);
        const before = await view.readPixels();
        console.log(`gi: Hammer ${JSON.stringify(view.stats)}`);
        await save("hammer-direct", direct);
        await save("hammer-baked", before);
        let gained = 0;
        for (let i = 0; i < direct.data.length; i += 4) {
          if (direct.data[i] < 8 && before.data[i] > 15) gained++;
        }
        if (gained < 200) {
          throw new Error(
            `Hammer shadowed surfaces did not receive bounce light: ${gained}`,
          );
        }
        const pillar = byName("pillar_a"),
          position = pillar.components.transform.position as number[];
        const started = performance.now();
        s.setComponent(pillar.id, "transform", {
          ...pillar.components.transform,
          position: [position[0] + 0.8, position[1], position[2]],
        });
        render(false);
        if (view.stats.lightmapSamples !== 2 || !view.stats.pendingWork) {
          throw new Error("live edit did not start a background bake");
        }
        for (let i = 0; i < 15; i++) {
          render(false);
          await renderer.device.queue.onSubmittedWorkDone();
        }
        const rebakeMs = performance.now() - started;
        if (view.stats.pendingWork) {
          throw new Error("background rebake did not finish");
        }
        if (hardware && rebakeMs > 3000) {
          throw new Error(`Hammer rebake exceeded three seconds: ${rebakeMs}`);
        }
        await save("hammer-edited", await view.readPixels());
        s.undo();
        render(true);
        const undo = await view.readPixels();
        if (undo.data.some((v, i) => v !== before.data[i])) {
          throw new Error("Hammer undo did not reproduce the bake");
        }
        job.measurements = {
          fixtureBakeMs: result.bakeMs,
          hammerRebakeMs: rebakeMs,
          shadowedPixelsLit: gained,
          reflectionPixels: reflections.reflectionPixels,
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
    () => (globalThis as unknown as Global).giJob.done,
    undefined,
    { timeout: 180000 },
  );
  const result = await page.evaluate(() => {
    const job = (globalThis as unknown as Global).giJob;
    return {
      error: job.error,
      pictures: job.pictures ?? {},
      measurements: job.measurements,
    };
  });
  assertEquals(errors, []);
  await Deno.mkdir("tmp", { recursive: true });
  const suffix = hardware ? "hardware" : "software";
  for (const [name, png] of Object.entries(result.pictures)) {
    await Deno.writeFile(
      `tmp/gi-${name}-${suffix}.png`,
      Uint8Array.from(atob(png), (c) => c.charCodeAt(0)),
    );
  }
  await page.screenshot({ path: `tmp/gi-editor-${suffix}.png` });
  if (result.error) throw new Error(result.error);
  console.log(
    "✓ bounce light, probes, SSR, Hammer brush rebakes and deterministic undo",
    result.measurements,
  );
} finally {
  await browser.close();
  await server.close();
}
