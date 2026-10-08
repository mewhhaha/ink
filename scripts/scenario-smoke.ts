/** Prove the editor catches a broken jump and shows its tick and pixel diff. */
import { assert, assertEquals } from "@std/assert";
import { chromium } from "playwright-core";
import type { Scenario, ScenarioResult } from "@ink/core";
import type { InkAutomation } from "@ink/dev/automation";
import type { SceneFile } from "@ink/schema";
import { findChromium, startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import { callAutomation } from "../packages/dev/browser.ts";

const server = await startServer(await resolveProject("examples/feel"), {
  port: 0,
  quiet: true,
});
const browser = await chromium.launch({
  executablePath: await findChromium(),
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
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const port = (server.httpServer!.address() as { port: number }).port;
  await page.goto(`http://127.0.0.1:${port}/?ink-automation`);
  await page.waitForFunction(() => "__ink" in globalThis);
  await callAutomation(page, "ready", undefined);
  await page.getByRole("button", { name: "Run test", exact: true }).click();
  await page.waitForFunction(() =>
    (globalThis as unknown as { __ink: InkAutomation }).__ink.state().tick ===
      180
  );
  await page.getByRole("button", { name: "Run test", exact: true }).waitFor();
  assertEquals(
    await page.getByRole("button", { name: "Failure at tick 72", exact: true })
      .count(),
    0,
  );
  const broken: Scenario = await page.evaluate(async () => {
    const scenario: Scenario = await (await fetch("/__ink/scenarios/jump"))
      .json();
    const state: SceneFile = await (await fetch("/__ink/scenes/main")).json();
    const runner = state.entities.find((e) => e.components.runner)!;
    runner.components.runner = {
      ...runner.components.runner as object,
      jump_speed: 0,
    };
    return { ...scenario, name: "Broken jump", scene: undefined, state };
  });
  const result: ScenarioResult = await callAutomation(page, "scenario", {
    scenario: broken,
  });
  assert(!result.passed);
  assertEquals(result.tick, 72);
  assert(result.failures.some((f) => f.message.includes("position.1")));
  assert(
    result.images[0].error > 0,
    "the missing jump changes the golden image",
  );
  assert(result.failures[0].diff?.startsWith("data:image/png;base64,"));
  await page.getByRole("button", { name: "Failure at tick 72", exact: true })
    .first().click();
  await page.getByRole("dialog", { name: "Scenario failure" }).waitFor();
  await page.getByAltText("Image difference").waitFor();
  await Deno.mkdir("tmp", { recursive: true });
  await page.screenshot({ path: "tmp/scenario-failure.png" });
  assertEquals(errors, []);
  console.log(
    "✓ recorded jump, editor run control, failing tick and image diff in Chromium",
  );
} finally {
  await browser.close();
  await server.close();
}
