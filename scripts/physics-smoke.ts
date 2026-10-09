/**
 * Physics in the browser: the Godot example's physics scene runs 300 steps in
 * headless Chromium (SwiftShader WebGPU) and must end in exactly the state the
 * Deno runner reaches; then the viewport's Physics toggle draws colliders and
 * contacts, and a picture is saved to tmp/physics-smoke.png.
 *
 *   deno task test:physics
 */
import { chromium } from "playwright-core";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { startServer } from "../packages/dev/cli.ts";
import { resolveProject } from "../packages/dev/node.ts";
import type { SceneFile } from "@ink/schema";
import type { InkAutomation } from "@ink/dev/automation";

const root = new URL("../", import.meta.url).pathname;
const project = await resolveProject(join(root, "examples/godot"));
const out = join(root, "tmp", "physics-deno.scene.json");
await Deno.mkdir(join(root, "tmp"), { recursive: true });

const ran = await new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "-A",
    join(root, "packages/dev/cli.ts"),
    "run",
    project.dir,
    "--scene",
    "physics",
    "--ticks",
    "300",
    "--out",
    out,
  ],
  stdout: "null",
  stderr: "piped",
}).output();
assert(ran.success, new TextDecoder().decode(ran.stderr));
const deno: SceneFile = JSON.parse(await Deno.readTextFile(out));

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
const server = await startServer(project, { port: 0, quiet: true });
const address = server.httpServer?.address();
const port = typeof address === "object" && address ? address.port : 0;
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/?ink-automation`);
  await page.waitForFunction(() => "__ink" in globalThis, null, {
    timeout: 60000,
  });
  await page.evaluate(() =>
    (globalThis as unknown as { __ink: InkAutomation }).__ink.ready
  );
  const chromium300: SceneFile = await page.evaluate(() =>
    (globalThis as unknown as { __ink: InkAutomation }).__ink.run({
      scene: "physics",
      ticks: 300,
    })
  );
  const strip = (scene: SceneFile) =>
    scene.entities.map((e) => ({
      id: e.id,
      transform: e.components.transform,
      body: e.components.body,
      character: e.components.character,
    }));
  assertEquals(
    strip(chromium300),
    strip(deno),
    "Chromium and Deno end 300 steps in identical states",
  );
  const sleeping = chromium300.entities.filter((e) =>
    (e.components.body as { sleeping?: boolean } | undefined)?.sleeping
  ).length;
  assert(sleeping > 15, `settled bodies sleep (${sleeping})`);

  // The Physics toggle draws; the view keeps rendering without errors.
  const toggle = page.locator('button[aria-label^="Show colliders"]').first();
  await toggle.click();
  assertEquals(await toggle.getAttribute("aria-pressed"), "true");
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: join(root, "tmp", "physics-smoke.png"),
    timeout: 120000,
  });
  assertEquals(errors, [], "no page errors");
  console.log(
    `physics: Chromium == Deno after 300 steps (${chromium300.entities.length} entities, ${sleeping} asleep)`,
  );
} finally {
  await browser.close();
  await server.close();
}
Deno.exit(0);
