import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer, preview } from "vite";
import { microseconds } from "@ink/runtime/session.ts";
import { Observer } from "@ink/observability/observer.ts";
import { create_redacting_sink } from "@ink/observability/redaction.ts";
import { create_ring_buffer_sink } from "@ink/observability/sink.ts";
import { create_narrative_session } from "../runtime.ts";
import { signal_warning_beat } from "../contract.ts";
import {
  finish_narrative_timeline,
  required_action,
} from "../headless/scenario.ts";
import { narrative_presentation } from "../presentation.ts";

const application_directory = fileURLToPath(new URL("../../", import.meta.url));
const starter_file = fileURLToPath(
  new URL("../../projects/starter.json", import.meta.url),
);
const generated_directory = fileURLToPath(
  new URL("../../generated/", import.meta.url),
);
const artifact_directory = fileURLToPath(
  new URL("../../../../artifacts/visual-novel/", import.meta.url),
);
const viewport = { width: 960, height: 540 };
const laid_out_signal_warning = [
  "Station: Warning: the green signal does not belong to this line.",
  "Follow the station map past the final service tunnel before boarding.",
].join("\n");

test(
  "the browser saves and lays out a beat, plays both endings, and matches headless replay",
  { timeout: 120_000 },
  async () => {
    const original_starter = await readFile(starter_file, "utf8");
    const temporary_directory = await mkdtemp(
      join(tmpdir(), "ink-visual-novel-browser-"),
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
        cacheDir: join(temporary_directory, "vite-cache"),
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
      const origin = `http://127.0.0.1:${address.port}`;

      browser = await chromium.launch({
        headless: true,
        args: [
          "--enable-unsafe-webgpu",
          "--enable-features=Vulkan",
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
      await page.goto(origin, {
        waitUntil: "domcontentloaded",
      });
      await wait_for_runtime(page, browser_errors);
      const initial_development = await development_evidence(page);
      assert.equal(initial_development.type, "ready");
      assert.equal(initial_development.entry_retained, false);
      const initial_descriptor = await fetch_development_descriptor(origin);
      assert_development_units(initial_descriptor, {
        base_revision: null,
        changed: ["game", "project"],
        retained: [],
      });
      assert.equal(initial_development.revision, initial_descriptor.revision);
      await assert_renderer_evidence(page);
      const initial_navigation_count = navigations;
      assert.equal(
        await page.locator("main").getAttribute("data-beat-count"),
        "2",
      );
      assert.equal(
        await page.locator("main").getAttribute("data-editor-id"),
        "narrative",
      );
      await page.getByText("Narrative editor", { exact: true })
        .waitFor({ state: "visible" });
      await page.getByText(
        "Author scenes, dialogue beats, decisions, story state, and endings.",
        { exact: true },
      ).waitFor({ state: "visible" });
      await wait_for_initial_dialogue(page, browser_errors);
      const initial_dialogue = await browser_dialogue_layout(page);
      assert.equal(initial_dialogue.visible_line_count, 1);
      assert.equal(initial_dialogue.white_space, "pre");
      await prove_editor_outliner_keyboard_focus(page);
      await prove_debugger_window_keyboard_close(page);

      await page.getByRole("button", { name: "Add signal warning" })
        .click();
      await page.waitForFunction(
        (expected_dialogue) =>
          document.querySelector("main")?.getAttribute("data-beat-count") ===
            "3" &&
          document.querySelector('[data-ink-ui-id="narrative.dialogue"]')
              ?.textContent === expected_dialogue,
        laid_out_signal_warning,
      );
      const edited_dialogue = await browser_dialogue_layout(page);
      assert.equal(edited_dialogue.text, laid_out_signal_warning);
      assert.equal(edited_dialogue.aria_label, laid_out_signal_warning);
      assert.equal(
        edited_dialogue.text.replace("\n", " "),
        `${signal_warning_beat.speaker}: ${signal_warning_beat.text}`,
      );
      assert.equal(edited_dialogue.visible_line_count, 2);
      assert.equal(edited_dialogue.white_space, "pre");
      assert.ok(
        edited_dialogue.inline_height > initial_dialogue.inline_height,
      );
      assert.ok(
        edited_dialogue.rendered_height > initial_dialogue.rendered_height,
      );
      assert.ok(
        Math.abs(
          edited_dialogue.inline_height - edited_dialogue.line_height * 2,
        ) < 0.25,
      );
      assert.ok(
        edited_dialogue.maximum_line_width <=
          edited_dialogue.inline_width + 0.5,
      );
      assert.equal(edited_dialogue.horizontal_overflow, false);
      assert.equal(edited_dialogue.vertical_overflow, false);
      assert.equal(navigations, initial_navigation_count);
      assert.notEqual(
        await readFile(temporary_project, "utf8"),
        original_starter,
      );
      assert.equal(await readFile(starter_file, "utf8"), original_starter);
      const activated = await wait_for_development_activation(
        page,
        initial_development.revision,
        browser_errors,
      );
      assert.equal(activated.entry_retained, true);
      assert.equal(activated.state_preserved, true);
      const edited_descriptor = await fetch_development_descriptor(origin);
      assert_development_units(edited_descriptor, {
        base_revision: initial_descriptor.revision,
        changed: ["project"],
        retained: ["game"],
      });
      assert.equal(activated.revision, edited_descriptor.revision);

      await server.close();
      server = undefined;
      build_production_bundle();
      server = await preview({
        build: { outDir: join(application_directory, "dist") },
        configFile: false,
        logLevel: "silent",
        preview: { host: "127.0.0.1", port: 0 },
        root: application_directory,
      });
      const production_address = server.httpServer.address();
      if (
        typeof production_address !== "object" ||
        production_address === null ||
        !Number.isSafeInteger(production_address.port) ||
        production_address.port <= 0
      ) {
        throw new Error(
          `narrative production preview returned invalid address ${
            JSON.stringify(production_address)
          }`,
        );
      }
      const production_origin = `http://127.0.0.1:${production_address.port}`;
      await page.goto(production_origin, { waitUntil: "domcontentloaded" });
      await wait_for_runtime(page, browser_errors);
      await wait_for_production_runtime(page, browser_errors);
      await page.waitForFunction(
        (expected_dialogue) =>
          document.querySelector("main")?.getAttribute("data-beat-count") ===
            "3" &&
          document.querySelector('[data-ink-ui-id="narrative.dialogue"]')
              ?.textContent === expected_dialogue,
        laid_out_signal_warning,
      );
      await assert_renderer_evidence(page);
      const production_navigation_count = navigations;

      await page.locator(
        '[data-ink-ui-id="narrative.choice.follow-signal"]',
      ).click();
      try {
        await page.waitForFunction(
          () =>
            document.querySelector("main")?.getAttribute("data-outcome") ===
              "ending",
          undefined,
          { timeout: 30_000 },
        );
      } catch (cause) {
        throw new Error(
          `signal choice did not reach an ending: ${
            JSON.stringify(
              await page.evaluate(() => ({
                outcome: document.querySelector("main")?.getAttribute(
                  "data-outcome",
                ),
                runtime: document.querySelector("main")?.getAttribute(
                  "data-runtime-state",
                ),
                audioState: document.querySelector("main")?.getAttribute(
                  "data-audio-state",
                ),
                audioEvents: document.querySelector("main")?.getAttribute(
                  "data-audio-events",
                ),
                checksum: document.querySelector("main")?.getAttribute(
                  "data-snapshot-checksum",
                ),
                notice: document.querySelector(".runtime-notice")?.textContent,
                buttons: [...document.querySelectorAll("button")].map((
                  button,
                ) => button.getAttribute("aria-label")),
              })),
            )
          }`,
          { cause },
        );
      }
      const first = await browser_outcome(page);
      assert.equal(first.ending, "The Answer");
      assert.match(first.evidence, /Unfamiliar signal/);

      await page.locator('[data-ink-ui-id="narrative.restart"]').click();
      await page.waitForFunction(() =>
        document.querySelector("main")?.getAttribute("data-outcome") ===
          "playing"
      );
      await page.locator(
        '[data-ink-ui-id="narrative.choice.board-train"]',
      ).click();
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
      await assert_renderer_evidence(page);
      await mkdir(artifact_directory, { recursive: true });
      const screenshot = await capture_narrative_render(page);
      const coverage = await rendered_coverage(page, screenshot);
      assert.ok(
        coverage.non_clear_fraction > 0.15,
        `visual-novel stage non-clear coverage ${coverage.non_clear_fraction} must exceed 0.15: ${
          JSON.stringify(coverage)
        }`,
      );
      await page.locator(".story-panel").screenshot({
        path: `${artifact_directory}/new-shore-ending.png`,
        timeout: 30_000,
        type: "png",
      });
      assert.ok(
        coverage.luminance_range > 20,
        `visual-novel stage luminance range ${coverage.luminance_range} must exceed 20: ${
          JSON.stringify(coverage)
        }`,
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
      assert.equal(navigations, production_navigation_count);
      const report_path = process.env.INK_SCENARIO_REPORT;
      if (report_path !== undefined) {
        const report = spawnSync(
          "deno",
          [
            "run",
            "--config",
            "../../deno.json",
            "--allow-env=INK_SCENARIO_REPORT",
            "--allow-read",
            "--allow-write",
            "../../scripts/write_scenario_report.ts",
            "--passed",
            "browser:beat-save-hot-reloads-without-navigation",
            "--passed",
            "browser:both-endings-match-headless-replay",
            "--passed",
            "browser:authored-audio-cues-play",
            "--passed",
            "browser:authored-localized-dialogue-layout-changes-visible-lines",
            "--passed",
            "browser:editor-outliner-keyboard-focus",
            "--passed",
            "browser:debugger-window-opens-and-closes-from-keyboard",
            "--passed",
            "browser:editor-catalog-defines-narrative-workflow",
            "--passed",
            "browser:canonical-renderer-draws-3d-stage",
          ],
          {
            cwd: application_directory,
            encoding: "utf8",
            env: process.env,
          },
        );
        if (report.error !== undefined) {
          throw new Error("narrative browser report could not start", {
            cause: report.error,
          });
        }
        if (report.status !== 0) {
          const evidence = report.stderr.trim() || report.stdout.trim() ||
            `signal ${report.signal}`;
          throw new Error(
            `narrative browser report exited with ${report.status}: ${evidence}`,
          );
        }
      }
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

async function wait_for_runtime(page, browser_errors) {
  try {
    await page.waitForFunction(() => {
      const state = document.querySelector("main")?.getAttribute(
        "data-runtime-state",
      );
      return state === "ready" || state === "failed";
    });
  } catch (cause) {
    const evidence = await page.evaluate(() => ({
      body: document.body.textContent?.slice(0, 1_000),
      runtime_state: document.querySelector("main")?.getAttribute(
        "data-runtime-state",
      ),
      runtime_notice: document.querySelector(".runtime-notice")?.textContent,
    }));
    throw new Error(
      `narrative browser runtime did not settle: ${
        JSON.stringify({ ...evidence, browser_errors })
      }`,
      { cause },
    );
  }
  const state = await page.locator("main").getAttribute("data-runtime-state");
  if (state === "ready") return;
  const notice = await page.locator(".runtime-notice").textContent();
  throw new Error(
    `narrative browser runtime failed: ${notice ?? "no evidence"}`,
  );
}

async function wait_for_production_runtime(page, browser_errors) {
  try {
    await page.waitForFunction(
      () =>
        document.querySelector("main")?.getAttribute(
          "data-development-status",
        ) === "production",
    );
  } catch (cause) {
    throw new Error(
      `narrative production runtime did not publish its boundary: ${
        JSON.stringify(browser_errors)
      }`,
      { cause },
    );
  }
}

async function development_evidence(page) {
  return await page.locator("main").evaluate((application) => ({
    type: application.dataset.developmentStatus,
    revision: application.dataset.developmentRevision,
    entry_retained: application.dataset.developmentEntryRetained === undefined
      ? undefined
      : application.dataset.developmentEntryRetained === "true",
    state_preserved: application.dataset.developmentStatePreserved === undefined
      ? undefined
      : application.dataset.developmentStatePreserved === "true",
  }));
}

async function wait_for_development_activation(
  page,
  previous_revision,
  browser_errors,
) {
  try {
    await page.waitForFunction(
      (previous_revision) => {
        const application = document.querySelector("main");
        return application?.dataset.developmentStatus === "ready" &&
          application.dataset.developmentRevision !== previous_revision &&
          application.dataset.developmentEntryRetained === "true" &&
          application.dataset.developmentStatePreserved === "true";
      },
      previous_revision,
      { polling: 10 },
    );
  } catch (cause) {
    throw new Error(
      `narrative development activation did not complete: ${
        JSON.stringify({
          evidence: await development_evidence(page),
          browser_errors,
        })
      }`,
      { cause },
    );
  }
  return await development_evidence(page);
}

async function fetch_development_descriptor(origin) {
  const response = await fetch(
    `${origin}/narrative_development.development.json`,
    { cache: "no-store" },
  );
  assert.equal(response.status, 200);
  return await response.json();
}

function assert_development_units(descriptor, expected) {
  assert.equal(descriptor.format, "ink-blot-development-revision");
  assert.equal(descriptor.version, 1);
  assert.equal(descriptor.snapshot.entry_unit, "game");
  assert.equal(descriptor.delta.base_revision, expected.base_revision);
  assert.deepEqual(
    descriptor.delta.changed_units.map(({ name }) => name),
    expected.changed,
  );
  assert.deepEqual(
    descriptor.delta.retained_units.map(({ name }) => name),
    expected.retained,
  );
}

async function wait_for_initial_dialogue(page, browser_errors) {
  try {
    await page.waitForFunction(() =>
      document.querySelector('[data-ink-ui-id="narrative.dialogue"]')
        ?.textContent?.includes(
          "Mara: The last train waits beneath a sky full of signals.",
        )
    );
  } catch (cause) {
    const evidence = await page.evaluate(() => ({
      dialogue: document.querySelector(
        '[data-ink-ui-id="narrative.dialogue"]',
      )?.textContent,
      notice: document.querySelector(".runtime-notice")?.textContent,
      outcome: document.querySelector("main")?.getAttribute("data-outcome"),
      runtime: document.querySelector("main")?.getAttribute(
        "data-runtime-state",
      ),
      timeline_duration: document.querySelector("main")?.getAttribute(
        "data-timeline-duration",
      ),
      timeline_elapsed: document.querySelector("main")?.getAttribute(
        "data-timeline-elapsed",
      ),
    }));
    throw new Error(
      `narrative initial dialogue did not appear: ${
        JSON.stringify({ ...evidence, browser_errors })
      }`,
      { cause },
    );
  }
}

async function assert_renderer_evidence(page) {
  const stage = page.locator(".visual-novel-stage");
  await stage.waitFor({ state: "visible" });
  await page.waitForFunction(() =>
    document.querySelector(".visual-novel-stage")?.getAttribute(
      "data-render-ready",
    ) === "true"
  );
  const evidence = await stage.evaluate((element) => ({
    adapter: element.getAttribute("data-render-adapter"),
    failed: element.getAttribute("data-render-failed"),
    frame: element.getAttribute("data-render-frame"),
    status: element.getAttribute("data-render-status"),
    validation_errors: element.getAttribute("data-render-validation-errors"),
  }));
  assert.equal(evidence.failed, "false");
  assert.equal(evidence.frame, "raster");
  assert.equal(evidence.status, "ready");
  assert.equal(evidence.validation_errors, "0");
  assert.ok(evidence.adapter !== null && evidence.adapter.length > 0);
  assert.doesNotMatch(
    evidence.adapter,
    /fallback|llvmpipe|software|swiftshader/i,
  );
}

async function rendered_coverage(page, screenshot) {
  return await page.evaluate(async (encoded_png) => {
    const rendered = new Image();
    rendered.src = `data:image/png;base64,${encoded_png}`;
    await rendered.decode();
    const copy = document.createElement("canvas");
    copy.width = rendered.naturalWidth;
    copy.height = rendered.naturalHeight;
    const context = copy.getContext("2d", { willReadFrequently: true });
    if (context === null) {
      throw new Error("visual-novel screenshot proof has no 2D context");
    }
    context.drawImage(rendered, 0, 0);
    const image = context.getImageData(0, 0, copy.width, copy.height);
    const corner = [image.data[0], image.data[1], image.data[2]];
    let non_clear = 0;
    let samples = 0;
    let luminance_minimum = Number.POSITIVE_INFINITY;
    let luminance_maximum = 0;
    for (let y = 0; y < image.height; y += 8) {
      for (let x = 0; x < image.width; x += 8) {
        const offset = (y * image.width + x) * 4;
        const red = image.data[offset];
        const green = image.data[offset + 1];
        const blue = image.data[offset + 2];
        const distance = Math.abs(red - corner[0]) +
          Math.abs(green - corner[1]) + Math.abs(blue - corner[2]);
        if (distance > 18) non_clear += 1;
        const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
        luminance_minimum = Math.min(luminance_minimum, luminance);
        luminance_maximum = Math.max(luminance_maximum, luminance);
        samples += 1;
      }
    }
    return {
      height: image.height,
      luminance_range: luminance_maximum - luminance_minimum,
      non_clear_fraction: non_clear / samples,
      width: image.width,
    };
  }, screenshot.toString("base64"));
}

async function capture_narrative_render(page) {
  const overlay = page.locator(".narrative-ui");
  await overlay.evaluate((element) => {
    element.style.visibility = "hidden";
  });
  try {
    return await page.locator(".visual-novel-stage canvas").screenshot({
      path: `${artifact_directory}/new-shore-render.png`,
      timeout: 30_000,
      type: "png",
    });
  } finally {
    await overlay.evaluate((element) => {
      element.style.visibility = "";
    });
  }
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
    ending: (await page.locator('[data-ink-ui-id="blot.game"]')
      .getAttribute("aria-label")) ?? "",
    evidence: (await page.locator(
      '[data-ink-ui-id="narrative.evidence"]',
    ).textContent()) ?? "",
  };
}

async function browser_dialogue_layout(page) {
  return await page.locator('[data-ink-ui-id="narrative.dialogue"]')
    .evaluate((element) => {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      const line_rectangles = [...range.getClientRects()]
        .filter(({ width, height }) => width > 0 && height > 0);
      const visible_line_tops = new Set(
        line_rectangles.map(({ top }) => Math.round(top * 100) / 100),
      );
      const style = getComputedStyle(element);
      return {
        aria_label: element.getAttribute("aria-label"),
        horizontal_overflow: element.scrollWidth > element.clientWidth + 1,
        inline_height: Number.parseFloat(element.style.height),
        inline_width: Number.parseFloat(element.style.width),
        line_height: Number.parseFloat(style.lineHeight),
        maximum_line_width: Math.max(
          0,
          ...line_rectangles.map(({ width }) => width),
        ),
        rendered_height: element.getBoundingClientRect().height,
        text: element.textContent ?? "",
        vertical_overflow: element.scrollHeight > element.clientHeight + 1,
        visible_line_count: visible_line_tops.size,
        white_space: style.whiteSpace,
      };
    });
}

async function prove_editor_outliner_keyboard_focus(page) {
  const outliner = page.getByRole("tree", { name: "Narrative scenes" });
  const station = outliner.getByRole("button", {
    name: "The Last Station · 2 beats",
    exact: true,
  });
  const observatory = outliner.getByRole("button", {
    name: "The Observatory · 1 beats",
    exact: true,
  });
  await station.focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await observatory.evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(
    await observatory.locator("xpath=ancestor::li[@role='treeitem'][1]")
      .getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("ArrowUp");
  assert.equal(
    await station.evaluate((element) => element === document.activeElement),
    true,
  );
  const styles = await station.evaluate((element) => {
    const tree_element = element.closest('[role="tree"]');
    if (!(tree_element instanceof HTMLElement)) {
      throw new Error("narrative station row is outside the editor outliner");
    }
    const button = getComputedStyle(element);
    const tree = getComputedStyle(tree_element);
    return {
      display: button.display,
      minimum_height: Number.parseFloat(button.minHeight),
      list_style: tree.listStyleType,
    };
  });
  assert.equal(styles.display, "flex");
  assert.ok(styles.minimum_height >= 24);
  assert.equal(styles.list_style, "none");
}

async function prove_debugger_window_keyboard_close(page) {
  const toggle = page.getByRole("button", { name: "Runtime log" });
  await toggle.click();
  const debugger_window = page.getByRole("complementary", {
    name: "Game debugger",
  });
  await debugger_window.waitFor({ state: "visible" });
  await debugger_window.focus();
  await page.keyboard.press("Escape");
  await debugger_window.waitFor({ state: "detached" });
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
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
    const session = await create_narrative_session(
      wasm_bytes,
      manifest_source,
      new Observer({
        source: { subsystem: "narrative-browser-test" },
        sink: create_redacting_sink(create_ring_buffer_sink(100)),
        clock: { now_seconds: () => performance.now() / 1_000 },
      }),
    );
    try {
      let current = await finish_narrative_timeline(
        session,
        await session.observe(viewport),
      );
      if (choice_id === "board-train") {
        await session.advance({
          elapsed_us: microseconds(0),
          inputs: [required_action(current, "follow-signal")],
        });
        const first_ending = await session.observe(viewport);
        await session.advance({
          elapsed_us: microseconds(0),
          inputs: [narrative_presentation(first_ending).restart.action],
        });
        current = await finish_narrative_timeline(
          session,
          await session.observe(viewport),
        );
      }
      const revision = await session.advance({
        elapsed_us: microseconds(0),
        inputs: [required_action(current, choice_id)],
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

function build_production_bundle() {
  const build = spawnSync("pnpm", ["build"], {
    cwd: application_directory,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(
    build.status,
    0,
    `narrative production bundle failed:\n${build.stdout}\n${build.stderr}`,
  );
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
