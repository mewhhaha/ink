import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { microseconds } from "@ink/runtime/session.ts";
import { create_platformer_session } from "../runtime.ts";

const application_directory = fileURLToPath(new URL("../../", import.meta.url));
const starter_file = fileURLToPath(
  new URL("../../projects/starter.json", import.meta.url),
);
const generated_directory = fileURLToPath(
  new URL("../../generated/", import.meta.url),
);

test(
  "the browser saves an exit edit, hot reloads, renders, and completes the moved platformer",
  { timeout: 120_000 },
  async () => {
    const original_starter = await readFile(starter_file, "utf8");
    const temporary_directory = await mkdtemp(
      join(tmpdir(), "ink-platformer-browser-"),
    );
    const temporary_project = join(temporary_directory, "starter.json");
    await writeFile(temporary_project, original_starter, "utf8");
    process.env.INK_PLATFORMER_PROJECT_FILE = temporary_project;

    let server;
    let browser;
    try {
      const { default: configure } = await import(
        `../../ink.ts?browser=${crypto.randomUUID()}`
      );
      const configuration = await configure({
        command: "serve",
        mode: "browser-test",
        isSsrBuild: false,
        isPreview: false,
      });
      server = await createServer({
        ...configuration,
        configFile: false,
        logLevel: "silent",
        server: {
          ...configuration.server,
          host: "127.0.0.1",
          port: 0,
        },
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (
        typeof address !== "object" || address === null ||
        !Number.isSafeInteger(address.port) || address.port <= 0
      ) {
        throw new Error(
          `platformer browser server returned invalid address ${
            JSON.stringify(address)
          }`,
        );
      }

      browser = await chromium.launch({
        headless: true,
        args: [
          "--disable-vulkan-surface",
          "--enable-gpu",
          "--enable-features=Vulkan,UseSkiaRenderer,WebGPU,CanvasDrawElement",
          "--enable-unsafe-webgpu",
          "--ignore-gpu-blocklist",
          "--use-angle=vulkan",
        ],
      });
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      });
      const browser_errors = [];
      let navigations = 0;
      page.on("pageerror", (error) => browser_errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") browser_errors.push(message.text());
      });
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations += 1;
      });
      await page.goto(`http://127.0.0.1:${address.port}`, {
        waitUntil: "domcontentloaded",
      });
      await wait_for_runtime(page);
      await page.waitForFunction(() =>
        document.querySelector("main")?.getAttribute("data-renderer-mode") !==
          "loading"
      );
      const initial_navigation_count = navigations;
      const initial_gpu = await page.locator("main").evaluate((main) => ({
        adapter: main.dataset.gpuAdapter,
        mode: main.dataset.rendererMode,
        notice: main.querySelector(".runtime-notice")?.textContent,
        webgpu: "gpu" in navigator,
      }));
      if (initial_gpu.mode !== "webgpu") {
        throw new Error(
          `platformer browser requires hardware WebGPU; mode=${
            JSON.stringify(initial_gpu.mode)
          } adapter=${
            JSON.stringify(initial_gpu.adapter)
          } navigator.gpu=${initial_gpu.webgpu} notice=${
            JSON.stringify(initial_gpu.notice)
          }`,
        );
      }
      assert.notEqual(initial_gpu.adapter, "unavailable");

      const canvas = page.locator("canvas");
      assert.equal(
        await canvas.getAttribute("data-object-ids"),
        "100,101,102,103",
      );
      assert.equal(await canvas.getAttribute("data-validation-errors"), "0");
      assert.equal(await canvas.getAttribute("data-exit-x"), "29500000");
      const covered_pixels = await non_clear_pixels(page);
      if (covered_pixels < 100) {
        throw new Error(
          `platformer WebGPU frame covered only ${covered_pixels} sampled pixels`,
        );
      }

      await page.getByRole("button", { name: "Move exit right" }).click();
      await page.waitForFunction(() =>
        document.querySelector("canvas")?.dataset.exitX === "30500000"
      );
      assert.equal(navigations, initial_navigation_count);
      assert.notEqual(
        await readFile(temporary_project, "utf8"),
        original_starter,
      );
      assert.equal(await readFile(starter_file, "utf8"), original_starter);

      await page.locator("main").focus();
      await page.keyboard.down("ArrowRight");
      await page.keyboard.down("Space");
      await page.locator('[data-transport="play"]').click();
      await page.waitForFunction(() =>
        document.querySelector("canvas")?.dataset.snapshotChecksum !== undefined
      );
      await page.keyboard.up("Space");
      await page.waitForFunction(() =>
        document.querySelector("main")?.getAttribute("data-outcome") === "won"
      );
      await page.keyboard.up("ArrowRight");

      const browser_checksum = await canvas.getAttribute(
        "data-snapshot-checksum",
      );
      if (browser_checksum === null || browser_checksum.length === 0) {
        throw new Error(
          "platformer browser did not publish a runtime checksum",
        );
      }
      const browser_status = await page.locator(".status-card span")
        .textContent();
      const headless = await play_generated_platformer();
      try {
        const replay = await headless.session.finish_replay();
        await headless.session.reset();
        const replayed = await headless.session.replay(replay);
        assert.equal(replayed.snapshot_checksum, headless.checksum);
        assert.equal(browser_checksum, headless.checksum);
        assert.equal(
          browser_status,
          headless.presentation.observation.status.value,
        );
      } finally {
        await headless.session.close();
      }

      assert.equal(await canvas.getAttribute("data-validation-errors"), "0");
      assert.deepEqual(browser_errors, []);
      assert.equal(navigations, initial_navigation_count);
    } finally {
      await browser?.close();
      await server?.close();
      delete process.env.INK_PLATFORMER_PROJECT_FILE;
      await rm(temporary_directory, { recursive: true });
      await rebuild_starter_artifact();
      assert.equal(await readFile(starter_file, "utf8"), original_starter);
    }
  },
);

async function wait_for_runtime(page) {
  await page.waitForFunction(() => {
    const state = document.querySelector("main")?.getAttribute(
      "data-runtime-state",
    );
    return state === "ready" || state === "failed";
  });
  const state = await page.locator("main").getAttribute("data-runtime-state");
  if (state === "ready") return;
  const notice = await page.locator(".runtime-notice").textContent();
  throw new Error(
    `platformer browser runtime failed: ${notice ?? "no evidence"}`,
  );
}

async function non_clear_pixels(page) {
  return await page.locator("canvas").evaluate(async (canvas) => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const source = canvas.toDataURL("image/png");
    const image = new Image();
    image.src = source;
    await image.decode();
    const sample = document.createElement("canvas");
    sample.width = 160;
    sample.height = 90;
    const context = sample.getContext("2d");
    if (context === null) {
      throw new Error("browser pixel sample has no 2D context");
    }
    context.drawImage(image, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    let covered = 0;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] > 32) covered += 1;
    }
    return covered;
  });
}

async function play_generated_platformer() {
  const [wasm_bytes, manifest_source] = await Promise.all([
    readFile(join(generated_directory, "platformer_development.wasm")),
    readFile(
      join(generated_directory, "platformer_development.wasm.json"),
      "utf8",
    ),
  ]);
  const session = await create_platformer_session(wasm_bytes, manifest_source);
  const initial = await session.observe({ width: 960, height: 540 });
  const right = required_action(initial, "right-start");
  const jump = required_action(initial, "jump");
  let revision = await session.advance({
    elapsed_us: microseconds(50_000),
    inputs: [right, jump],
  });
  let presentation = await session.observe({ width: 960, height: 540 });
  for (
    let frame = 1;
    !presentation.observation.status.done && frame < 100;
    frame += 1
  ) {
    revision = await session.advance({
      elapsed_us: microseconds(50_000),
      inputs: [],
    });
    presentation = await session.observe({ width: 960, height: 540 });
  }
  if (!presentation.observation.status.done) {
    await session.close();
    throw new Error(
      "headless platformer did not reach the moved exit in 100 frames",
    );
  }
  return { session, checksum: revision.snapshot_checksum, presentation };
}

function required_action(presentation, id) {
  const action = presentation.observation.actions.find((candidate) =>
    candidate.id === id
  )?.action;
  if (action === undefined) {
    throw new Error(`platformer action ${JSON.stringify(id)} is missing`);
  }
  return action;
}

async function rebuild_starter_artifact() {
  await new Promise((resolve, reject) => {
    const build = spawn("pnpm", ["build:game"], {
      cwd: application_directory,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const errors = [];
    build.stderr.on("data", (chunk) => errors.push(chunk));
    build.on("error", (cause) => {
      reject(
        new Error("platformer starter artifact rebuild could not start", {
          cause,
        }),
      );
    });
    build.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const evidence = Buffer.concat(errors).toString("utf8");
      reject(
        new Error(
          signal
            ? `platformer starter artifact rebuild stopped after ${signal}: ${evidence}`
            : `platformer starter artifact rebuild exited with ${code}: ${evidence}`,
        ),
      );
    });
  });
}
