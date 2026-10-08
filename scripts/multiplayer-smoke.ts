/** Two independent browser contexts play the real Feel Lab through the relay. */
import { assert, assertEquals } from "@std/assert";
import { type Browser, chromium, type Page } from "playwright-core";
import { findChromium, startServer } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import type { InkAutomation } from "@ink/dev/automation";
import type { Ink } from "../packages/react/context.tsx";
import { callAutomation } from "../packages/dev/browser.ts";

type Global = {
  __ink: InkAutomation;
  response?: {
    ms: number;
    tick: number;
    confirmed: number;
    startTick: number;
    beforeX: number;
    x: number;
  };
  [key: symbol]: Promise<{ ink: Ink }>;
};
const server = await startServer(await resolveProject("examples/feel"), {
  port: 0,
  quiet: true,
});
let browser: Browser | undefined;
await Deno.mkdir("tmp", { recursive: true });
try {
  browser = await chromium.launch({
    executablePath: await findChromium(),
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan=swiftshader",
      "--use-webgpu-adapter=swiftshader",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });
  const pages: Page[] = [];
  const errors: string[] = [];
  const port = (server.httpServer!.address() as { port: number }).port;
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({
      viewport: { width: 1760, height: 1000 },
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/?ink-automation`);
    await page.waitForFunction(() => "__ink" in globalThis);
    await callAutomation(page, "ready", undefined);
    pages.push(page);
  }
  const status = (page: Page) =>
    page.evaluate(() => (globalThis as unknown as Global).__ink.network());
  for (const page of pages) {
    await page.getByRole("button", { name: "Multiplayer", exact: true })
      .click();
    await page.getByRole("textbox", { name: "Room", exact: true }).fill(
      "rollback-smoke",
    );
    await page.getByRole("button", { name: "Join room", exact: true }).click();
  }
  for (const page of pages) {
    await page.waitForFunction(
      () => {
        const status = (globalThis as unknown as Global).__ink.network();
        return status?.phase === "playing" && status.confirmed >= 30;
      },
      undefined,
      { timeout: 45000 },
    );
  }
  console.log("joined", await Promise.all(pages.map(status)));
  for (let peer = 0; peer < 2; peer++) {
    const page = pages[peer];
    await page.locator('[data-view-id="game"]').focus();
    // Measure from the actual key event to the locally predicted world change.
    await page.evaluate(async (peer) => {
      const g = globalThis as unknown as Global;
      const { ink } = await g[Symbol.for("ink.boot")];
      const position = () => {
        const e = g.__ink.state().entities.find((e) =>
          (e.components.runner as { player?: number } | undefined)?.player ===
            peer
        )!;
        return (e.components.transform as { position: number[] }).position[0];
      };
      addEventListener("keydown", () => {
        const start = performance.now(),
          x = position(),
          startTick = g.__ink.network()!.tick;
        const off = ink.session.subscribe(() => {
          const s = g.__ink.network()!;
          if (position() !== x) {
            g.response = {
              ms: performance.now() - start,
              tick: ink.session.tick,
              confirmed: s.confirmed,
              startTick,
              beforeX: x,
              x: position(),
            };
            off();
          }
        });
      }, { once: true, capture: true });
    }, peer);
    await page.keyboard.down(peer ? "a" : "d");
    await page.waitForFunction(() =>
      !!(globalThis as unknown as Global).response
    );
    const response = await page.evaluate(() =>
      (globalThis as unknown as Global).response!
    );
    console.log(`player ${peer + 1} response`, response);
    assert(
      peer ? response.x < response.beforeX : response.x > response.beforeX,
      "each peer's real input moves its own runner in the requested direction",
    );
    assert(
      response.tick <= response.startTick + 1,
      "local motion appears on the first local step",
    );
    if (Deno.args.includes("--timing")) {
      assert(
        response.ms < 100,
        "local motion appears before the 100 ms network delay",
      );
    }
    await page.keyboard.up(peer ? "a" : "d");
  }
  await pages[0].locator('[data-view-id="game"]').focus();
  await pages[0].waitForFunction(() =>
    (globalThis as unknown as Global).__ink.state().entities.some((e) => {
      const runner = e.components.runner as {
        player?: number;
        grounded?: boolean;
      } | undefined;
      return runner?.player === 0 && runner.grounded;
    })
  );
  await pages[0].keyboard.down("Space");
  const start = (await status(pages[0]))!.tick;
  await pages[0].waitForFunction(
    (tick) =>
      (globalThis as unknown as Global).__ink.network()!.tick >= tick + 24,
    start,
  );
  await pages[0].keyboard.up("Space");
  await pages[0].keyboard.up("d");
  await pages[1].keyboard.up("a");
  const states = await Promise.all(pages.map(status));
  for (const state of states) {
    assertEquals(state!.delayMs, 100);
    assert(state!.rollbacks > 0);
    assertEquals(state!.mode, "rollback");
  }
  const confirmed = Math.min(...states.map((s) => s!.confirmed)) - 2;
  const snapshots = await Promise.all(
    pages.map((page) =>
      page.evaluate(
        (tick) => (globalThis as unknown as Global).__ink.network(tick)!,
        confirmed,
      )
    ),
  );
  assertEquals(snapshots[0].hash, snapshots[1].hash);
  assertEquals(
    snapshots[0].state,
    snapshots[1].state,
    "confirmed Wasm packets converge byte for byte",
  );
  const scene = await pages[0].evaluate(() =>
    (globalThis as unknown as Global).__ink.state()
  );
  const runners = scene.entities.filter((e) => e.components.runner);
  assert(
    Number((scene.resources?.run as { jumps?: number })?.jumps) >= 1,
    "player 1 jumped through real input",
  );
  assertEquals(runners.length, 2);
  await pages[0].screenshot({ path: "tmp/multiplayer-player1.png" });
  await pages[1].screenshot({ path: "tmp/multiplayer-player2.png" });
  // The peer sees a disconnect and retains its replay, paused for inspection.
  await pages[1].close();
  await pages[0].getByRole("button", { name: "Room closed", exact: true })
    .waitFor();
  assertEquals(await status(pages[0]), null);
  const replayed = await pages[0].evaluate(async (tick) => {
    const { ink } =
      await (globalThis as unknown as Global)[Symbol.for("ink.boot")];
    if (!ink.session.paused) {
      throw new Error("disconnected game must remain paused");
    }
    ink.session.seek(tick);
    return Array.from(ink.session.state);
  }, confirmed);
  assertEquals(
    replayed,
    snapshots[0].state,
    "the editor timeline retains corrected network inputs",
  );
  assertEquals(errors, []);
  await Deno.writeTextFile(
    "tmp/multiplayer-results.json",
    JSON.stringify({ states, confirmed, hash: snapshots[0].hash }, null, 2),
  );
  console.log(
    "✓ two players, 100 ms one-way delay, local prediction, rollback convergence and disconnect",
  );
} finally {
  await Promise.allSettled([browser?.close(), server.close()]);
}
