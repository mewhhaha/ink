/** Serve only production artifacts at a subpath and play each example. */
import { assert, assertEquals } from "@std/assert";
import { chromium } from "playwright-core";
import { findChromium } from "@ink/dev/cli";
import { resolveProject } from "@ink/dev/node";
import { buildPlayer } from "../packages/dev/build.ts";
import type { bootPlayer } from "@ink/player";
import { resolveInside } from "../packages/dev/paths.ts";

type Global = {
  __inkPlayer: ReturnType<typeof bootPlayer>;
  __gamepad?: {
    connected: boolean;
    axes: number[];
    buttons: { pressed: boolean; value: number }[];
  };
};
const hardware = Deno.args.includes("--hardware");
const headed = Deno.args.includes("--headed");
const timings: Record<string, number> = {};
const names = ["feel", "godot", "trenchbroom", "hammer"];
const builds = new Map<string, string>();
for (const name of names) {
  const build = await buildPlayer(await resolveProject(`examples/${name}`));
  assert(
    build.bytes < 5_000_000,
    `${name} player is under 5 MB excluding assets`,
  );
  builds.set(name, build.out);
  console.log(
    `${name}: ${(build.bytes / 1e6).toFixed(2)} MB player + ${
      (build.assetBytes / 1e6).toFixed(2)
    } MB assets`,
  );
}
const types: Record<string, string> = {
  js: "text/javascript",
  css: "text/css",
  html: "text/html",
  wasm: "application/wasm",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
};
const server = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen() {} },
  async (request) => {
    const path = new URL(request.url).pathname;
    const match = /^\/play\/([^/]+)\/(.*)$/.exec(path);
    if (!match || !builds.has(match[1])) {
      return new Response("Not found", {
        status: 404,
      });
    }
    try {
      const file = resolveInside(
        builds.get(match[1])!,
        match[2] || "index.html",
      );
      return new Response(await Deno.readFile(file), {
        headers: {
          "content-type": types[file.split(".").at(-1)!] ??
            "application/octet-stream",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
);
const browser = await chromium.launch({
  executablePath: await findChromium(),
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
try {
  await Deno.mkdir("tmp", { recursive: true });
  for (const name of names) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });
    const errors: string[] = [];
    const requests: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => requests.push(r.url()));
    page.on("console", (m) => {
      if (m.type() === "error") console.error(`${name}: ${m.text()}`);
    });
    await page.goto(
      `http://127.0.0.1:${server.addr.port}/play/${name}/?ink-automation`,
    );
    await page.waitForFunction(() => "__inkPlayer" in globalThis);
    const readyMs = await page.evaluate(async () =>
      (await (globalThis as unknown as Global).__inkPlayer).readyMs
    );
    timings[name] = readyMs;
    console.log(`${name}: ready in ${Math.round(readyMs)} ms`);
    if (hardware) {
      const adapter = await page.evaluate(async () =>
        (await navigator.gpu.requestAdapter())!.info
      );
      assert(
        !adapter.isFallbackAdapter &&
          !/swiftshader|llvmpipe|software/i.test(
            `${adapter.vendor} ${adapter.description}`,
          ),
        "hardware mode needs a real GPU",
      );
      assert(
        readyMs < 2000,
        `${name} first hardware frame took ${Math.round(readyMs)} ms`,
      );
    }
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(async () =>
      (await (globalThis as unknown as Global).__inkPlayer).player.tick >= 30
    );
    await page.keyboard.press("Space");
    await page.keyboard.down("KeyD");
    await page.waitForFunction(async () =>
      (await (globalThis as unknown as Global).__inkPlayer).player.tick >= 50
    );
    await page.keyboard.up("KeyD");
    await page.screenshot({ path: `tmp/player-${name}.png` });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Game menu" }).waitFor();
    if (name === "feel") {
      await page.getByRole("button", { name: "Bind jump keys", exact: true })
        .click();
      await page.keyboard.press("KeyJ");
      assertEquals(
        await page.getByRole("button", { name: "Bind jump keys", exact: true })
          .innerText(),
        "J",
      );
      await page.reload();
      await page.getByRole("button", { name: "Play", exact: true }).waitFor();
      assertEquals(
        await page.getByRole("button", { name: "Bind jump keys", exact: true })
          .innerText(),
        "J",
      );
      await page.screenshot({ path: "tmp/player-controls.png" });
    }
    assertEquals(errors, []);
    assert(
      !requests.some((r) =>
        r.includes("/__ink/") || r.includes("/@vite/") ||
        r.includes("packages/react")
      ),
      "shipping pages do not contact the editor or dev server",
    );
    await page.close();
  }
  const touch = await browser.newPage({
    viewport: { width: 900, height: 600 },
    hasTouch: true,
    isMobile: true,
  });
  await touch.goto(
    `http://127.0.0.1:${server.addr.port}/play/feel/?ink-automation`,
  );
  await touch.getByRole("button", { name: "Play", exact: true }).click();
  await touch.waitForFunction(async () =>
    (await (globalThis as unknown as Global).__inkPlayer).player.tick >= 30
  );
  const before = await touch.evaluate(async () =>
    Number(
      (await (globalThis as unknown as Global).__inkPlayer).player.world
        .resources
        .run.jumps,
    )
  );
  await touch.getByRole("button", { name: "Touch jump", exact: true }).tap();
  await touch.waitForFunction(
    async (before: number) =>
      Number(
        (await (globalThis as unknown as Global).__inkPlayer).player.world
          .resources.run.jumps,
      ) > before,
    before,
  );
  await touch.screenshot({ path: "tmp/player-touch.png" });
  await touch.close();
  await Deno.writeTextFile(
    `tmp/player-timings-${hardware ? "hardware" : "software"}.json`,
    JSON.stringify(timings, null, 2),
  );
  console.log(
    "✓ all four static players, saved controls and touch jump in Chromium",
  );
} finally {
  await browser.close();
  await server.shutdown();
}
