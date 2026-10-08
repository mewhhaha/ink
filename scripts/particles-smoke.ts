/** Real Godot Blot bursts, GPU pixels, timeline scrubbing and handoff replay. */
import { assertEquals } from "@std/assert";
import { chromium } from "playwright-core";
import { findChromium, startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import { callAutomation } from "../packages/dev/browser.ts";
import type { Ink } from "../packages/react/context.tsx";
import type { InkAutomation } from "@ink/dev/automation";
import type * as Core from "@ink/core";
import type * as Transparency from "../packages/render/transparency_checks.ts";
import type * as Particles from "../packages/render/particles_checks.ts";

type Job = {
  pending?: Promise<void>;
  done?: boolean;
  error?: string;
  png?: string;
  tick?: number;
};
type Global = {
  __ink: InkAutomation;
  particleJob: Job;
  [key: symbol]: Promise<{ ink: Ink }>;
};
const root = new URL("../", import.meta.url).pathname;
const hardware = Deno.args.includes("--hardware");
const server = await startServer(await resolveProject("examples/godot"), {
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
    viewport: { width: 1440, height: 900 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const port = (server.httpServer!.address() as { port: number }).port;
  await page.goto(`http://127.0.0.1:${port}/?ink-automation`);
  await page.waitForFunction(() => "__ink" in globalThis);
  await callAutomation(page, "ready", undefined);
  await page.evaluate((root) => {
    const g = globalThis as unknown as Global;
    const job: Job = g.particleJob = {};
    job.pending = (async () => {
      const { ink } = await g[Symbol.for("ink.boot")];
      const renderer = ink.renderer!;
      const errors: string[] = [];
      renderer.device.addEventListener(
        "uncapturederror",
        (e) => errors.push((e as GPUUncapturedErrorEvent).error.message),
      );
      const transparency = await import(
        `/@fs${root}packages/render/transparency_checks.ts`
      ) as typeof Transparency;
      const particles = await import(
        `/@fs${root}packages/render/particles_checks.ts`
      ) as typeof Particles;
      await transparency.checkTransparency(renderer);
      await particles.checkParticles(renderer);
      await g.__ink.run({ scene: "particles", ticks: 0 });
      const s = ink.session;
      s.play();
      for (let tick = 0; tick < 260; tick++) {
        const input = s.input.sample(tick, s.dt, tick * s.dt);
        input.actions.jump = {
          down: tick === 230,
          pressed: tick === 230,
          released: false,
        };
        s.stepFrame(input);
      }
      if (
        !s.presentationEvents.some((f) =>
          f.events.some((e) => e.name === "particles")
        )
      ) throw new Error("Blot emitted no burst");
      if (ink.scene().particles?.length !== 3) {
        throw new Error("fire, smoke and sparks were not extracted");
      }
      const options = {
        view: "game",
        width: 960,
        height: 540,
        quality: "high" as const,
      };
      const before = await g.__ink.capture(options);
      const packet = Array.from(s.state);
      for (let i = 0; i < 60; i++) s.stepFrame();
      s.seek(260);
      if (before.png !== (await g.__ink.capture(options)).png) {
        throw new Error("particle rewind changed captured pixels");
      }
      const core = await import(
        `/@fs${root}packages/core/mod.ts`
      ) as typeof Core;
      const handoff = core.buildHandoff(s, {
        note: "GPU effects",
        replaySeconds: 0,
      });
      const replay = JSON.parse(
        handoff.files.find((f) => f.name === "replay.json")!.text!,
      );
      if (replay.keyframe.tick !== 240) {
        throw new Error("expected a keyframe after the burst");
      }
      core.replayHandoff(s, replay, "particles");
      if (packet.some((v, i) => v !== s.state[i])) {
        throw new Error("handoff changed the world packet");
      }
      const after = await g.__ink.capture(options);
      if (before.png !== after.png) {
        throw new Error("handoff lost a pre-keyframe burst");
      }
      if (errors.length) throw new Error(errors.join("\n"));
      job.png = before.png;
      job.tick = s.tick;
    })().then(() => {
      job.done = true;
    }, (e) => {
      job.error = e.stack ?? String(e);
      job.done = true;
    });
  }, root);
  await page.waitForFunction(
    () => (globalThis as unknown as Global).particleJob.done,
    undefined,
    { timeout: 180000 },
  );
  const result = await page.evaluate(() => {
    const job = (globalThis as unknown as Global).particleJob;
    if (job.error) throw new Error(job.error);
    return { png: job.png!, tick: job.tick! };
  });
  assertEquals(result.tick, 260);
  assertEquals(errors, []);
  await Deno.mkdir("tmp", { recursive: true });
  const suffix = hardware ? "hardware" : "software";
  await Deno.writeFile(
    `tmp/particles-${suffix}.png`,
    Uint8Array.from(
      atob(result.png.split(",").at(-1)!),
      (c) => c.charCodeAt(0),
    ),
  );
  await page.screenshot({ path: `tmp/particles-editor-${suffix}.png` });
  console.log(
    "✓ linear transparency, cutouts, GPU fire/smoke/sparks, Blot bursts, exact rewind and handoff pictures",
  );
} finally {
  await browser.close();
  await server.close();
}
