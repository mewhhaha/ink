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
import { create_narrative_session } from "../runtime.ts";

const application_directory = fileURLToPath(new URL("../../", import.meta.url));
const starter_file = fileURLToPath(
  new URL("../../projects/starter.json", import.meta.url),
);
const generated_directory = fileURLToPath(
  new URL("../../generated/", import.meta.url),
);
const viewport = { width: 960, height: 540 };

test(
  "the browser saves a beat, hot reloads, plays both endings, and matches headless replay",
  { timeout: 120_000 },
  async () => {
    const original_starter = await readFile(starter_file, "utf8");
    const temporary_directory = await mkdtemp(
      join(tmpdir(), "ink-narrative-browser-"),
    );
    const temporary_project = join(temporary_directory, "starter.json");
    await writeFile(temporary_project, original_starter, "utf8");
    process.env.INK_NARRATIVE_PROJECT_FILE = temporary_project;

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
          `narrative browser server returned invalid address ${
            JSON.stringify(address)
          }`,
        );
      }

      browser = await chromium.launch({ headless: true });
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
      const initial_navigation_count = navigations;
      assert.equal(
        await page.locator("main").getAttribute("data-beat-count"),
        "1",
      );
      await assert_text(
        page,
        "Mara: The last train waits beneath a sky full of signals.",
      );

      await page.getByRole("button", { name: "Add platform announcement" })
        .click();
      await page.waitForFunction(() =>
        document.querySelector("main")?.getAttribute("data-beat-count") ===
          "2" &&
        document.querySelector(".story-panel p")?.textContent?.includes(
          "Station: The final service now boards from platform three.",
        )
      );
      assert.equal(navigations, initial_navigation_count);
      assert.notEqual(
        await readFile(temporary_project, "utf8"),
        original_starter,
      );
      assert.equal(await readFile(starter_file, "utf8"), original_starter);

      await page.getByRole("button", { name: "Follow the signal", exact: true })
        .click();
      await page.waitForFunction(() =>
        document.querySelector("main")?.getAttribute("data-outcome") ===
          "ending"
      );
      const first = await browser_outcome(page);
      assert.equal(first.ending, "The Answer");
      assert.match(first.evidence, /Unfamiliar signal/);

      await page.getByRole("button", { name: "Restart story", exact: true })
        .click();
      await page.waitForFunction(() =>
        document.querySelector("main")?.getAttribute("data-outcome") ===
          "playing"
      );
      await page.getByRole("button", { name: "Board the train", exact: true })
        .click();
      await page.waitForFunction(() =>
        document.querySelector("main")?.getAttribute("data-outcome") ===
          "ending"
      );
      const second = await browser_outcome(page);
      assert.equal(second.ending, "A New Shore");
      assert.match(second.evidence, /Silver train ticket/);
      assert.notEqual(first.checksum, second.checksum);
      assert.equal(
        await page.locator("main").getAttribute("data-audio-events"),
        "2",
      );
      assert.equal(
        await page.locator("main").getAttribute("data-audio-state"),
        "running",
      );

      const headless = await play_headless_branches();
      assert.deepEqual(
        [first.checksum, second.checksum],
        headless.map(({ checksum }) => checksum),
      );
      assert.deepEqual(
        headless.map(({ checksum, replay_checksum }) =>
          checksum === replay_checksum
        ),
        [true, true],
      );
      assert.deepEqual(browser_errors, []);
      assert.equal(navigations, initial_navigation_count);
    } finally {
      await browser?.close();
      await server?.close();
      delete process.env.INK_NARRATIVE_PROJECT_FILE;
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
    `narrative browser runtime failed: ${notice ?? "no evidence"}`,
  );
}

async function assert_text(page, expected) {
  const text = await page.locator(".story-panel p").textContent();
  assert.ok(
    (text ?? "").includes(expected),
    `narrative story text does not include ${JSON.stringify(expected)}: ${
      JSON.stringify(text)
    }`,
  );
}

async function browser_outcome(page) {
  const checksum = await page.locator("main").getAttribute(
    "data-snapshot-checksum",
  );
  if (checksum === null || checksum.length === 0) {
    throw new Error("narrative browser did not publish a runtime checksum");
  }
  return {
    checksum,
    ending: (await page.locator(".story-panel h2").textContent()) ?? "",
    evidence: (await page.locator(".story-panel p").textContent()) ?? "",
  };
}

async function play_headless_branches() {
  const [wasm_bytes, manifest_source] = await Promise.all([
    readFile(join(generated_directory, "narrative_development.wasm")),
    readFile(
      join(generated_directory, "narrative_development.wasm.json"),
      "utf8",
    ),
  ]);
  const outcomes = [];
  for (const choice_id of ["follow-signal", "board-train"]) {
    const session = await create_narrative_session(wasm_bytes, manifest_source);
    try {
      const initial = await session.observe(viewport);
      const action = initial.observation.actions.find(({ id }) =>
        id === choice_id
      )
        ?.action;
      if (action === undefined) {
        throw new Error(`headless narrative action ${choice_id} is missing`);
      }
      const revision = await session.advance({
        elapsed_us: microseconds(0),
        inputs: [action],
      });
      const replay = await session.finish_replay();
      await session.reset();
      const replayed = await session.replay(replay);
      outcomes.push({
        checksum: revision.snapshot_checksum,
        replay_checksum: replayed.snapshot_checksum,
      });
    } finally {
      await session.close();
    }
  }
  return outcomes;
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
        new Error("narrative starter artifact rebuild could not start", {
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
            ? `narrative starter artifact rebuild stopped after ${signal}: ${evidence}`
            : `narrative starter artifact rebuild exited with ${code}: ${evidence}`,
        ),
      );
    });
  });
}
