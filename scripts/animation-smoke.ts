/** Real Feel Lab clip transitions, joint attachments, scrubbing and handoffs. */
import { assertEquals } from "@std/assert";
import { chromium } from "playwright-core";
import { findChromium, startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import { callAutomation } from "../packages/dev/browser.ts";
import type { Ink } from "../packages/react/context.tsx";
import type { InkAutomation } from "@ink/dev/automation";
import type * as Core from "@ink/core";
import type * as Render from "@ink/render";
import type * as Geometry from "@ink/geometry";
import type * as Checks from "../packages/render/animation_checks.ts";

type Job = {
  pending?: Promise<void>;
  done?: boolean;
  error?: string;
  pictures?: Record<string, string>;
  tick?: number;
};
type Global = {
  __ink: InkAutomation;
  animationJob: Job;
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
    viewport: { width: 1440, height: 900 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      m.text().startsWith("animation:") ||
      ["error", "warning"].includes(m.type())
    ) console.log(m.text());
  });
  const port = (server.httpServer!.address() as { port: number }).port;
  await page.goto(`http://127.0.0.1:${port}/?ink-automation`);
  await page.waitForFunction(() => "__ink" in globalThis);
  await callAutomation(page, "ready", undefined);
  await page.evaluate(({ root, hardware }) => {
    const g = globalThis as unknown as Global, job: Job = g.animationJob = {};
    job.pending = (async () => {
      const { ink } = await g[Symbol.for("ink.boot")],
        renderer = ink.renderer!,
        s = ink.session;
      const validation: string[] = [];
      const info = renderer.device.adapterInfo;
      console.log(
        `animation: adapter ${info.vendor} ${info.architecture} ${info.description}`,
      );
      if (
        hardware &&
        (info.isFallbackAdapter ||
          /swiftshader|software|llvmpipe/i.test(info.description))
      ) throw new Error("hardware check selected software");
      renderer.device.lost.then((loss) =>
        console.log(`animation: device lost ${loss.reason}: ${loss.message}`)
      );
      renderer.device.addEventListener(
        "uncapturederror",
        (e) => validation.push((e as GPUUncapturedErrorEvent).error.message),
      );
      const checks = await import(
        `/@fs${root}packages/render/animation_checks.ts`
      ) as typeof Checks;
      const api = await import(
        `/@fs${root}packages/render/mod.ts`
      ) as typeof Render;
      const { mat4 } = await import(
        `/@fs${root}packages/geometry/mod.ts`
      ) as typeof Geometry;
      console.log("animation: GPU/CPU pixel oracle");
      await checks.checkAnimation(renderer);
      await g.__ink.run({ scene: "main", ticks: 0 });
      renderer.assets.preload("mesh", "models/runner.glb");
      await renderer.assets.settled();
      const imported = renderer.assets.modelData("models/runner.glb");
      if (imported?.clips.map((c) => c.name).join(",") !== "Idle,Walk,Jump") {
        throw new Error("character clips did not load");
      }
      const pictures: Record<string, string> = {};
      const capture = async () => {
        const scene = ink.scene(),
          body = scene.draws.find((d) => d.entity === 3)!;
        const model = renderer.assets.modelData("models/runner.glb")!;
        const pose = api.poseModel(model, body.animation);
        const hand = mat4.transformPoint(
          mat4.multiply(body.matrix, pose.nodes[11]),
          [0, -0.06, 0.03],
        );
        const beacon = scene.matrices.get(16)!;
        if (hand.some((v, i) => Math.abs(v - beacon[12 + i]) > 1e-5)) {
          throw new Error("joint attachment lost the current pose");
        }
        const at = s.world.entities.find((e) => e.id === 2)!.components
          .transform.position as [number, number, number];
        const camera = api.lookAtCamera([at[0] + 2.2, at[1] + 0.7, 3.1], at, {
          fov: 32,
        }, 1.5);
        const view = renderer.createView({ width: 720, height: 480 });
        try {
          view.render(scene, camera, {
            still: true,
            quality: hardware ? "high" : "low",
          });
          const blob = await view.capture();
          return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        } finally {
          view.dispose();
        }
      };
      const step = (move = 0, jump = false, pressed = false) => {
        const input = s.input.sample(s.tick, s.dt, s.tick * s.dt);
        input.actions.move = move;
        input.actions.jump = { down: jump, pressed, released: false };
        s.stepFrame(input);
      };
      const animation = () =>
        s.world.entities.find((e) => e.id === 3)!.components.animation;
      s.play();
      for (let i = 0; i < 40; i++) step();
      if (animation().clip !== 1) {
        throw new Error("grounded idle did not choose Idle");
      }
      pictures.idle = await capture();
      console.log("animation: idle, walk, jump from Blot state");
      for (let i = 0; i < 20; i++) step(1);
      if (animation().clip !== 2 || animation().blend !== 1) {
        throw new Error("running did not blend into Walk");
      }
      pictures.walk = await capture();
      step(1, true, true);
      if (animation().clip !== 3 || Number(animation().blend) >= 1) {
        throw new Error("jump did not begin a crossfade");
      }
      for (let i = 0; i < 11; i++) step(1, true);
      if (animation().clip !== 3 || animation().loop !== false) {
        throw new Error("airborne pose did not choose non-looping Jump");
      }
      pictures.jump = await capture();
      if (pictures.walk === pictures.jump || pictures.idle === pictures.walk) {
        throw new Error("clip changes did not change pictures");
      }
      const tick = s.tick, packet = Array.from(s.state);
      for (let i = 0; i < 50; i++) step();
      s.seek(tick);
      if (
        packet.some((v, i) => v !== s.state[i]) ||
        pictures.jump !== await capture()
      ) throw new Error("timeline scrub changed animation state or pixels");
      console.log("animation: rewind, handoff and asset reload");
      const core = await import(
        `/@fs${root}packages/core/mod.ts`
      ) as typeof Core;
      const bundle = core.buildHandoff(s, { note: "Animated character pose" });
      const replay = JSON.parse(
        bundle.files.find((f) => f.name === "replay.json")!.text!,
      );
      core.replayHandoff(s, replay, "main");
      if (
        packet.some((v, i) => v !== s.state[i]) ||
        pictures.jump !== await capture()
      ) throw new Error("handoff changed the animation pose");
      renderer.assets.reload("models/runner.glb");
      await renderer.assets.settled();
      if (
        renderer.assets.modelData("models/runner.glb") === imported ||
        pictures.jump !== await capture()
      ) throw new Error("asset reload lost a live pose");
      s.select([3]);
      if (validation.length) throw new Error(validation.join("\n"));
      job.pictures = pictures;
      job.tick = tick;
    })().then(() => {
      job.done = true;
    }, (e) => {
      job.error = e.stack ?? String(e);
      job.done = true;
    });
  }, { root, hardware });
  await page.waitForFunction(
    () => (globalThis as unknown as Global).animationJob.done,
    undefined,
    { timeout: 180000 },
  );
  const result = await page.evaluate(() => {
    const job = (globalThis as unknown as Global).animationJob;
    if (job.error) throw new Error(job.error);
    return { pictures: job.pictures!, tick: job.tick };
  });
  assertEquals(result.tick, 72);
  assertEquals(errors, []);
  await Deno.mkdir("tmp", { recursive: true });
  const suffix = hardware ? "hardware" : "software";
  for (const [name, png] of Object.entries(result.pictures)) {
    await Deno.writeFile(
      `tmp/animation-${name}-${suffix}.png`,
      Uint8Array.from(atob(png.split(",").at(-1)!), (c) => c.charCodeAt(0)),
    );
  }
  await page.screenshot({ path: `tmp/animation-editor-${suffix}.png` });
  console.log(
    "✓ CPU/GPU skinning and morphs, Feel Lab idle/walk/jump, attachments, exact scrub/handoff pixels and live asset reload",
  );
} finally {
  await browser.close();
  await server.close();
}
