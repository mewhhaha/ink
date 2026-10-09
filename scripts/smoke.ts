/**
 * Browser smoke test: boot every example in headless Chromium (SwiftShader
 * WebGPU), fail on page errors, play for a few seconds and check the game
 * advanced, then capture a picture of the editor.
 *
 *   deno task test:browser [examples/godot ...]
 */
import { chromium } from "playwright-core";
import { join } from "@std/path";
import { startServer } from "../packages/dev/cli.ts";
import { resolveProject } from "../packages/dev/node.ts";
import type { InputModel } from "@ink/schema";
import type { InkAutomation } from "@ink/dev/automation";
import { ensureTerrainData } from "./terrain-data.ts";

const root = new URL("../", import.meta.url).pathname;
const chosen = Deno.args.length > 0
  ? Deno.args
  : [...Deno.readDirSync(join(root, "examples"))]
    .filter((e) => e.isDirectory)
    .map((e) => `examples/${e.name}`)
    .sort();
if (chosen.some((p) => p.replace(/\/$/, "").endsWith("examples/terrain"))) {
  await ensureTerrainData();
}

const chrome = Deno.env.get("INK_CHROMIUM") ??
  `${
    Deno.env.get("HOME")
  }/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--use-vulkan=swiftshader",
    "--use-webgpu-adapter=swiftshader",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});

let failed = 0;
for (const path of chosen) {
  const started = performance.now();
  const project = await resolveProject(join(root, path));
  const server = await startServer(project, { port: 0, quiet: true });
  const address = server.httpServer?.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("404")) {
      errors.push(m.text());
    }
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/?ink-automation`);
    await page.waitForFunction(() => "__ink" in globalThis, null, {
      timeout: 60000,
    });
    await page.evaluate(() =>
      (globalThis as unknown as { __ink: { ready: Promise<void> } }).__ink.ready
    );
    const status = await page.evaluate(() => document.body.innerText);
    if (status.includes("does not compile")) {
      errors.push("the game does not compile");
    }
    await page.keyboard.press("F5");
    // SwiftShader renders slowly; give the game time to take some steps.
    const tick = await page.waitForFunction(
      () =>
        ((globalThis as unknown as { __ink: { state(): { tick?: number } } })
          .__ink.state().tick ?? 0) > 5,
      null,
      { timeout: 60000, polling: 500 },
    ).then(() =>
      page.evaluate(() =>
        (globalThis as unknown as { __ink: { state(): { tick?: number } } })
          .__ink.state().tick ?? 0
      )
    )
      .catch(() => 0);
    if (tick <= 0) errors.push("the game did not advance after play");
    await page.keyboard.press("F5");
    // Agents rely on captures being predictable: the same state and view
    // must give the same picture. Hardware GPUs repeat bit for bit; software
    // rendering may differ by one level in a few pixels, so compare content.
    const worst = await page.evaluate(async () => {
      const ink = (globalThis as unknown as {
        __ink: {
          capture(
            o: { view: string; width: number; height: number },
          ): Promise<{ png: string }>;
        };
      }).__ink;
      const pixels = async () => {
        const { png } = await ink.capture({
          view: "iso",
          width: 320,
          height: 180,
        });
        const image = new Image();
        image.src = png;
        await image.decode();
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const a = await pixels();
      const b = await pixels();
      let max = 0;
      for (let i = 0; i < a.length; i++) {
        max = Math.max(max, Math.abs(a[i] - b[i]));
      }
      return max;
    });
    if (worst > 1) {
      errors.push(`two captures of the same state differ (by up to ${worst})`);
    }
    const shot = join(root, "tmp", `smoke-${path.split("/").pop()}.png`);
    await Deno.mkdir(join(root, "tmp"), { recursive: true });
    await page.screenshot({ path: shot, timeout: 120000 });
    if (path.endsWith("/hammer")) {
      const inputs: InputModel[] = JSON.parse(
        await Deno.readTextFile(join(project.dir, "scripts/walkthrough.json")),
      );
      let from = 0;
      for (const to of [285, 650, inputs.length]) {
        const result = await page.evaluate(async ({ inputs, first }) => {
          const ink = (globalThis as unknown as { __ink: InkAutomation }).__ink;
          const world = await ink.run({
            scene: first ? "main" : undefined,
            inputs,
          });
          const capture = await ink.capture({
            view: "game",
            width: 640,
            height: 360,
          });
          if (capture.tick !== world.tick) {
            throw new Error("capture changed the live world");
          }
          return { world, png: capture.png };
        }, { inputs: inputs.slice(from, to), first: from === 0 });
        const png = Uint8Array.from(
          atob(result.png.split(",")[1]),
          (c) => c.charCodeAt(0),
        );
        await Deno.writeFile(
          join(root, "tmp", `hammer-walkthrough-${to}.png`),
          png,
        );
        const door = (name: string) =>
          (result.world.entities.find((e) => e.name === name)?.components
            .door as { progress?: number })?.progress ?? 0;
        if (to >= 285 && door("door1") < 0.99) {
          errors.push(`door1 did not open at ${to}`);
        }
        if (to >= 650 && door("door2") < 0.99) {
          errors.push(`door2 did not open at ${to}`);
        }
        if (to === inputs.length) {
          const game = result.world.resources?.game as {
            finished?: boolean;
            presses?: number;
          };
          if (!game?.finished || game.presses !== 2) {
            errors.push("Hammer button chain did not finish");
          }
        }
        from = to;
      }
      await page.locator(".hammer-complete-title").waitFor();
      await page.screenshot({
        path: join(root, "tmp", "hammer-walkthrough-complete.png"),
      });
      const beforeLanguage = await page.evaluate(() =>
        (globalThis as unknown as { __ink: InkAutomation }).__ink.state()
      );
      await page.getByLabel("Language", { exact: true }).selectOption("pl");
      await page.locator(".hammer-complete-title").filter({
        hasText: "Poziom ukończony",
      }).waitFor();
      const afterLanguage = await page.evaluate(() =>
        (globalThis as unknown as { __ink: InkAutomation }).__ink.state()
      );
      if (JSON.stringify(beforeLanguage) !== JSON.stringify(afterLanguage)) {
        errors.push("changing language changed game state");
      }
      await page.screenshot({
        path: join(root, "tmp", "hammer-localized.png"),
      });
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    if (errors.length) {
      failed++;
      console.log(`✗ ${path} (${seconds}s)\n  ${errors.join("\n  ")}`);
    } else {
      console.log(`✓ ${path} (${seconds}s, played to tick ${tick}) ${shot}`);
    }
  } catch (error) {
    failed++;
    console.log(`✗ ${path}: ${error instanceof Error ? error.message : error}`);
  } finally {
    await page.close();
    await server.close();
  }
}
await browser.close();
Deno.exit(failed ? 1 : 0);
