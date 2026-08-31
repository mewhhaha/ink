import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer, preview } from "vite";
import { move_platformer_record } from "@ink/platformer-editor/commands.ts";
import {
  platformer_level_id,
  platformer_record_id,
} from "@ink/platformer-editor/identity.ts";
import {
  parse_platformer_project,
  serialize_platformer_project,
} from "@ink/platformer-editor/serialization.ts";
import {
  parse_platformer_browser_evidence,
  platformer_presentation_evidence,
  serialize_platformer_presentation,
} from "../browser_evidence.ts";
import {
  platformer_scenario_frame_us,
  platformer_scenario_run_frames,
  play_platformer_to_exit,
} from "../headless/scenario.ts";
import { load_platformer_level_asset } from "../assets.ts";
import { create_platformer_runtime } from "../runtime.ts";

const application_directory = fileURLToPath(new URL("../../", import.meta.url));
const starter_file = fileURLToPath(
  new URL("../../projects/starter.json", import.meta.url),
);
const generated_directory = fileURLToPath(
  new URL("../../generated/", import.meta.url),
);
const artifact_directory = fileURLToPath(
  new URL("../../../../artifacts/platformer/", import.meta.url),
);
const edited_exit_assertion = "browser:edited-exit-rebuilds-and-reloads";
const parity_assertion = "browser:moved-exit-ui-matches-headless-replay";
const input_assertion = "browser:recorded-and-browser-input-frames-match";
const rendering_assertion = "browser:completed-level-renders-canonical-pixels";
const ui_assertion = "browser:blot-ui-adapter-restarts-level";
const animation_assertion =
  "browser:player-animation-changes-rendered-transform";
const asset_assertion = "browser:level-loads-verified-digest-artifact";

test(
  "the browser rebuilds a moved exit and matches the headless replay",
  { timeout: 120_000 },
  async () => {
    const original_starter = await readFile(starter_file, "utf8");
    const temporary_directory = await mkdtemp(
      join(tmpdir(), "ink-platformer-browser-"),
    );
    const temporary_project = join(temporary_directory, "starter.json");
    await writeFile(temporary_project, original_starter, "utf8");
    const previous_project_file = process.env.INK_PLATFORMER_PROJECT_FILE;
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
          `platformer browser server returned invalid address ${
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
      const asset_requests = [];
      let navigations = 0;
      page.on("pageerror", (error) => browser_errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") browser_errors.push(message.text());
      });
      page.on("requestfailed", (request) => {
        browser_errors.push(
          `${request.method()} ${request.url()} failed: ${
            request.failure()?.errorText ?? "unknown error"
          }`,
        );
      });
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path === "/assets.manifest.json" || path.startsWith("/assets/")) {
          asset_requests.push(path);
        }
      });
      page.on("response", (response) => {
        if (response.status() >= 400) {
          browser_errors.push(
            `${response.request().method()} ${response.url()} returned ${response.status()}`,
          );
        }
      });
      page.on("crash", () => browser_errors.push("browser page crashed"));
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations += 1;
      });
      await install_frame_control(page);
      await page.goto(origin, {
        waitUntil: "domcontentloaded",
      });
      await wait_for_runtime(page, browser_errors);
      const initial_navigation_count = navigations;
      const initial_development = await development_evidence(
        page,
        "#application",
      );
      assert.equal(initial_development.type, "ready");
      assert.equal(initial_development.entry_retained, false);
      const initial_descriptor = await fetch_development_descriptor(
        origin,
        "platformer_development",
      );
      assert_development_units(initial_descriptor, {
        base_revision: null,
        changed: ["game", "project"],
        retained: [],
      });
      assert.equal(initial_development.revision, initial_descriptor.revision);
      const initial = await browser_evidence(page);
      assert.deepEqual(initial.runtime, { type: "initial" });
      assert_renderer_evidence(initial);
      assert.equal(initial.renderer.center_pick, "platformer-object-10");
      assert.deepEqual(initial.scene.exit_position, [
        29_500_000,
        4_000_000,
        100_000,
      ]);
      assert.deepEqual(presentation_object(initial, 101).position, [
        13_000_000,
        3_500_000,
        0,
      ]);
      assert.equal(initial.animation.sample_time, 0);
      assert.deepEqual(initial.animation.rendered_position, [3, 2.75, 0.2]);
      assert.equal(initial.animation.rendered_rotation_z_radians, 0);
      assert.deepEqual(initial.animation.rendered_scale, [0.8, 1.5, 0.4]);
      assert.equal(initial.semantic.outcome, "running");
      await assert_semantic_controls(page, {
        status: "First steps",
        description: "Run and jump to the exit",
      });

      const starter = parse_platformer_project(original_starter);
      const moved_exit = move_platformer_record(
        starter,
        platformer_level_id("first-steps"),
        platformer_record_id("level-exit"),
        { x: 1, y: 0 },
      );
      const edited = move_platformer_record(
        moved_exit,
        platformer_level_id("first-steps"),
        platformer_record_id("step"),
        { x: 1, y: 0 },
      );
      const edited_source = serialize_platformer_project(edited);
      await writeFile(temporary_project, edited_source, "utf8");
      await wait_for_generated_project(edited_source);
      assert.notEqual(
        await readFile(temporary_project, "utf8"),
        original_starter,
      );
      assert.equal(await readFile(starter_file, "utf8"), original_starter);

      const activated = await wait_for_development_activation(
        page,
        "#application",
        initial_development.revision,
        browser_errors,
      );
      assert.equal(activated.entry_retained, true);
      assert.equal(activated.state_preserved, true);
      const edited_descriptor = await fetch_development_descriptor(
        origin,
        "platformer_development",
      );
      assert_development_units(edited_descriptor, {
        base_revision: initial_descriptor.revision,
        changed: ["project"],
        retained: ["game"],
      });
      assert.equal(activated.revision, edited_descriptor.revision);
      const rebuilt = await browser_evidence(page);
      assert.deepEqual(rebuilt.runtime, { type: "initial" });
      assert_renderer_evidence(rebuilt);
      assert.deepEqual(rebuilt.scene.exit_position, [
        30_500_000,
        4_000_000,
        100_000,
      ]);
      assert.deepEqual(presentation_object(rebuilt, 101).position, [
        14_000_000,
        3_500_000,
        0,
      ]);
      assert.equal(navigations, initial_navigation_count);

      const rapid_intermediate = serialize_platformer_project(
        rename_entry_level(edited, "Rapid save intermediate"),
      );
      const rapid_final_source = serialize_platformer_project(
        rename_entry_level(edited, "Retained first steps"),
      );
      const first_save_observed = wait_for_project_change(
        server,
        temporary_project,
      );
      await writeFile(temporary_project, rapid_intermediate, "utf8");
      await first_save_observed;
      await writeFile(temporary_project, rapid_final_source, "utf8");
      await wait_for_generated_project(rapid_final_source);
      await wait_for_edited_presentation(page, browser_errors);
      assert.deepEqual(
        presentation_object(await browser_evidence(page), 101).position,
        [
          14_000_000,
          3_500_000,
          0,
        ],
      );

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
          `platformer production preview returned invalid address ${
            JSON.stringify(production_address)
          }`,
        );
      }
      const production_origin = `http://127.0.0.1:${production_address.port}`;
      await page.goto(production_origin, { waitUntil: "domcontentloaded" });
      await wait_for_runtime(page, browser_errors);
      await wait_for_production_runtime(page, browser_errors);
      const production_initial = await browser_evidence(page);
      assert.deepEqual(production_initial.runtime, { type: "initial" });
      assert.deepEqual(production_initial.scene.exit_position, [
        30_500_000,
        4_000_000,
        100_000,
      ]);
      assert.deepEqual(presentation_object(production_initial, 101).position, [
        14_000_000,
        3_500_000,
        0,
      ]);
      await assert_semantic_controls(page, {
        status: "Retained first steps",
        description: "Run and jump to the exit",
      });
      const production_navigation_count = navigations;

      await page.keyboard.down("ArrowRight");
      await wait_for_sequence(page, 1);
      await page.keyboard.up("ArrowRight");
      await wait_for_input_frames(page, 2);
      for (let frame = 0; frame < platformer_scenario_run_frames; frame += 1) {
        await step_frame(page, platformer_scenario_frame_us / 1_000);
        await wait_for_sequence(page, frame + 2);
      }
      const before_jump = await browser_evidence(page);
      assert.equal(before_jump.semantic.outcome, "running");
      assert.deepEqual(before_jump.scene.player_position, [
        28_240_000,
        2_750_000,
        200_000,
      ]);
      assert.equal(before_jump.animation.sample_time, 0);
      assert.deepEqual(
        before_jump.animation.rendered_position,
        [28.24, 2.75, 0.2],
      );

      await page.keyboard.down("Space");
      await wait_for_sequence(page, 75);
      await page.keyboard.up("Space");
      await wait_for_input_frames(page, 4);
      assert.equal(
        (await browser_evidence(page)).semantic.status.value,
        "Jumping to the exit",
      );
      await step_frame(page, platformer_scenario_frame_us / 1_000);
      await wait_for_sequence(page, 76);
      const airborne = await browser_evidence(page);
      assert.equal(airborne.semantic.outcome, "running");
      assert.ok(airborne.scene.player_position[1] > 2_750_000);
      assert.ok(airborne.animation.sample_time > 0);
      assert.ok(airborne.animation.sample_time < 1);
      assert.ok(
        airborne.animation.rendered_position[1] >
          airborne.scene.player_position[1] / 1_000_000,
      );
      assert.ok(airborne.animation.rendered_rotation_z_radians < 0);
      await step_frame(page, platformer_scenario_frame_us / 1_000);
      await wait_for_sequence(page, 77);
      const completed = await browser_evidence(page);
      assert.deepEqual(completed.semantic.status, {
        done: true,
        label: "Classic adventure starter",
        value: "Moved exit reached",
      });
      assert.equal(completed.semantic.outcome, "won");
      assert_renderer_evidence(completed);
      assert.equal(completed.renderer.center_pick, "platformer-object-10");
      assert.deepEqual(completed.scene.player_position, [
        28_940_000,
        3_875_000,
        200_000,
      ]);
      assert.equal(completed.animation.sample_time, 1);
      assert.deepEqual(
        completed.animation.rendered_position,
        [28.94, 3.735, 0.2],
      );
      assert.ok(
        Math.abs(completed.animation.rendered_rotation_z_radians - 0.14) <
          1e-12,
      );
      assert.ok(
        Math.abs(completed.animation.rendered_scale[0] - 0.944) < 1e-12,
      );
      assert.ok(
        Math.abs(completed.animation.rendered_scale[1] - 1.26) < 1e-12,
      );
      assert.equal(completed.scene.exit_visible, false);
      assert.ok(completed.retained_observations > 0);
      assert.ok(completed.retained_observations <= 16);
      const visible_diagnostics = await page.locator("#diagnostics").evaluate(
        (output) => output.value,
      );
      assert.match(visible_diagnostics, /observations 16\/16/);
      assert.match(
        visible_diagnostics,
        /platformer\.browser\.presentation game_text="\[redacted\]"/,
      );
      assert.doesNotMatch(visible_diagnostics, /Moved exit reached/);
      if (completed.runtime.type !== "advanced") {
        throw new Error(
          `completed platformer runtime evidence was ${completed.runtime.type}`,
        );
      }
      await assert_semantic_controls(page, {
        status: "Classic adventure starter",
        description: "Moved exit reached",
      });
      await mkdir(artifact_directory, { recursive: true });
      await capture_completed_level(page);
      const render_surface = await capture_render_surface(page);
      const coverage = await rendered_coverage(page, render_surface);
      assert.ok(
        coverage.non_clear_fraction > 0.08,
        `platformer completed-level non-clear coverage ${coverage.non_clear_fraction} must exceed 0.08: ${
          JSON.stringify(coverage)
        }`,
      );
      assert.ok(
        coverage.luminance_range > 20,
        `platformer completed-level luminance range ${coverage.luminance_range} must exceed 20: ${
          JSON.stringify(coverage)
        }`,
      );

      const headless = await play_generated_platformer();
      assert.equal(headless.snapshot_checksum, headless.replay_checksum);
      assert.equal(
        completed.runtime.snapshot_checksum,
        headless.snapshot_checksum,
      );
      assert.deepEqual(
        {
          semantic: completed.semantic,
          scene: completed.scene,
        },
        platformer_presentation_evidence(headless.completed),
      );
      assert.deepEqual(
        platformer_presentation_evidence(headless.replayed),
        platformer_presentation_evidence(headless.completed),
      );
      assert.deepEqual(
        completed.encoded_input_frames,
        headless.encoded_input_frames,
      );
      assert.equal(
        completed.presentation_source,
        serialize_platformer_presentation(headless.completed),
      );
      assert.equal(
        serialize_platformer_presentation(headless.replayed),
        serialize_platformer_presentation(headless.completed),
      );

      await page.getByRole("button", { name: "Restart", exact: true }).click();
      await wait_for_status(page, "Run and jump to the exit");
      const restarted = await browser_evidence(page);
      if (restarted.runtime.type !== "advanced") {
        throw new Error(
          `restarted platformer runtime evidence was ${restarted.runtime.type}`,
        );
      }
      assert.ok(restarted.runtime.sequence > 77);
      assert.equal(restarted.semantic.outcome, "running");
      assert.equal(restarted.animation.sample_time, 0);
      assert.deepEqual(restarted.scene.player_position, [
        3_000_000,
        2_750_000,
        200_000,
      ]);
      await assert_semantic_controls(page, {
        status: "Retained first steps",
        description: "Run and jump to the exit",
      });
      assert.deepEqual(browser_errors, []);
      assert.equal(navigations, production_navigation_count);
      assert_digest_asset_requests(asset_requests);
      await assert_corrupt_digest_fails_closed(
        browser,
        production_origin,
      );
      write_scenario_report([
        edited_exit_assertion,
        parity_assertion,
        input_assertion,
        rendering_assertion,
        ui_assertion,
        animation_assertion,
        asset_assertion,
      ]);
    } finally {
      await browser?.close();
      await server?.close();
      delete process.env.INK_PLATFORMER_PROJECT_FILE;
      try {
        await rm(temporary_directory, { recursive: true, force: true });
        rebuild_starter_artifact();
        assert.equal(await readFile(starter_file, "utf8"), original_starter);
      } finally {
        if (previous_project_file !== undefined) {
          process.env.INK_PLATFORMER_PROJECT_FILE = previous_project_file;
        }
      }
    }
  },
);

function assert_digest_asset_requests(requests) {
  const manifests = requests.filter((path) => path === "/assets.manifest.json");
  const digest_artifacts = requests.filter((path) =>
    /^\/assets\/\.ink\/[0-9a-f]{64}$/.test(path)
  );
  assert.ok(
    manifests.length >= 2,
    `platformer browser requested ${manifests.length} asset manifests; expected one before and after rebuild: ${
      JSON.stringify(requests)
    }`,
  );
  assert.ok(
    digest_artifacts.length >= 2,
    `platformer browser requested ${digest_artifacts.length} digest artifacts; expected one before and after rebuild: ${
      JSON.stringify(requests)
    }`,
  );
  assert.equal(
    requests.includes("/assets/levels/first-steps.json"),
    false,
    `platformer browser bypassed the manifest with its raw level alias: ${
      JSON.stringify(requests)
    }`,
  );
}

async function assert_corrupt_digest_fails_closed(browser, application_url) {
  const page = await browser.newPage();
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.route("**/assets/.ink/*", async (route) => {
    const response = await route.fetch();
    const corrupted = Buffer.from(await response.body());
    if (corrupted.length === 0) {
      throw new Error("platformer digest artifact is unexpectedly empty");
    }
    corrupted[0] ^= 0xff;
    await route.fulfill({ response, body: corrupted });
  });
  try {
    await page.goto(application_url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        document.querySelector("#application")?.getAttribute(
          "data-runtime-state",
        ) === "failed",
      undefined,
      { polling: 10 },
    );
    await page.waitForTimeout(25);
    assert.ok(
      failures.some((message) =>
        message.includes("does not match manifest digest")
      ),
      `platformer corrupt digest did not report a verification failure: ${
        JSON.stringify(failures)
      }`,
    );
  } finally {
    await page.close();
  }
}

async function install_frame_control(page) {
  await page.addInitScript(() => {
    let next_frame = 1;
    let synthetic_now = performance.now();
    const callbacks = new Map();
    globalThis.requestAnimationFrame = (callback) => {
      const frame = next_frame;
      next_frame += 1;
      callbacks.set(frame, callback);
      return frame;
    };
    globalThis.cancelAnimationFrame = (frame) => callbacks.delete(frame);
    globalThis.__inkPlatformerFrames = Object.freeze({
      step(elapsed_ms) {
        synthetic_now = Math.max(synthetic_now, performance.now()) + elapsed_ms;
        const pending = [...callbacks.values()];
        callbacks.clear();
        for (const callback of pending) callback(synthetic_now);
      },
    });
  });
}

async function wait_for_runtime(page, browser_errors) {
  try {
    await page.waitForFunction(
      () => {
        const state = document.querySelector("#application")?.getAttribute(
          "data-runtime-state",
        );
        return state === "ready" || state === "failed";
      },
      undefined,
      { polling: 10 },
    );
  } catch (cause) {
    const diagnostics = await page.locator("#application").evaluate((
      element,
    ) => ({
      runtime_state: element.getAttribute("data-runtime-state"),
      status: element.querySelector("#status")?.textContent,
    }));
    throw new Error(
      `platformer browser runtime did not settle: ${
        JSON.stringify({ ...diagnostics, browser_errors })
      }`,
      { cause },
    );
  }
  const state = await page.locator("#application").getAttribute(
    "data-runtime-state",
  );
  if (state === "ready") return;
  throw new Error(
    `platformer browser runtime entered state ${JSON.stringify(state)}`,
  );
}

async function wait_for_production_runtime(page, browser_errors) {
  try {
    await page.waitForFunction(
      () =>
        document.querySelector("#application")?.getAttribute(
          "data-development-status",
        ) === "production",
      undefined,
      { polling: 10 },
    );
  } catch (cause) {
    throw new Error(
      `platformer production runtime did not publish its boundary: ${
        JSON.stringify(browser_errors)
      }`,
      { cause },
    );
  }
}

async function step_frame(page, elapsed_ms) {
  await page.evaluate((elapsed) => {
    const control = globalThis.__inkPlatformerFrames;
    if (control === undefined) {
      throw new Error("platformer frame control is missing");
    }
    control.step(elapsed);
  }, elapsed_ms);
}

async function wait_for_sequence(page, sequence) {
  await page.waitForFunction(
    (expected) => {
      const source = document.querySelector("#application")?.getAttribute(
        "data-platformer-evidence",
      );
      if (source === null || source === undefined) return false;
      const evidence = JSON.parse(source);
      return evidence.runtime?.type === "advanced" &&
        evidence.runtime.sequence === expected;
    },
    sequence,
    { polling: 10 },
  );
}

async function wait_for_input_frames(page, count) {
  await page.waitForFunction(
    (expected) => {
      const source = document.querySelector("#application")?.getAttribute(
        "data-platformer-evidence",
      );
      if (source === null || source === undefined) return false;
      return JSON.parse(source).encoded_input_frames?.length === expected;
    },
    count,
    { polling: 10 },
  );
}

async function wait_for_status(page, status) {
  await page.waitForFunction(
    (expected) => {
      const source = document.querySelector("#application")?.getAttribute(
        "data-platformer-evidence",
      );
      if (source === null || source === undefined) return false;
      return JSON.parse(source).semantic?.status?.value === expected;
    },
    status,
    { polling: 10 },
  );
}

async function browser_evidence(page) {
  const source = await page.locator("#application").getAttribute(
    "data-platformer-evidence",
  );
  if (source === null) {
    throw new Error("platformer browser did not publish typed evidence");
  }
  return parse_platformer_browser_evidence(source);
}

function presentation_object(evidence, object_id) {
  const presentation = JSON.parse(evidence.presentation_source);
  const object = presentation.snapshot.objects.find(({ id }) =>
    id === object_id
  );
  assert.notEqual(
    object,
    undefined,
    `platformer presentation omitted object ${object_id}`,
  );
  return object;
}

function rename_entry_level(project, name) {
  return {
    ...project,
    levels: project.levels.map((level) =>
      level.id === project.entry_level_id ? { ...level, name } : level
    ),
  };
}

function wait_for_project_change(server, project_file) {
  return new Promise((resolve_change) => {
    const observe_change = (changed_file) => {
      if (changed_file !== project_file) return;
      server.watcher.off("change", observe_change);
      resolve_change();
    };
    server.watcher.on("change", observe_change);
  });
}

async function wait_for_edited_presentation(page, browser_errors) {
  try {
    await page.waitForFunction(
      () => {
        const application = document.querySelector("#application");
        const source = application?.dataset.platformerEvidence;
        if (
          application?.dataset.developmentStatus !== "ready" ||
          source === undefined
        ) return false;
        const evidence = JSON.parse(source);
        const presentation = JSON.parse(evidence.presentation_source);
        const edited_platform = presentation.snapshot.objects.find(({ id }) =>
          id === 101
        );
        return evidence.scene.exit_position?.[0] === 30_500_000 &&
          edited_platform?.position?.[0] === 14_000_000 &&
          evidence.semantic.status?.label === "Retained first steps";
      },
      undefined,
      { polling: 10 },
    );
  } catch (cause) {
    throw new Error(
      `platformer rapid saves did not converge on the final project: ${
        JSON.stringify({
          evidence: await development_evidence(page, "#application"),
          browser_errors,
        })
      }`,
      { cause },
    );
  }
}

function assert_renderer_evidence(evidence) {
  assert.equal(evidence.renderer.status, "ready");
  assert.equal(evidence.renderer.validation_error_count, 0);
  assert.equal(evidence.renderer.frame_type, "raster");
  assert.doesNotMatch(
    evidence.renderer.adapter_description,
    /fallback|llvmpipe|software|swiftshader/i,
  );
}

async function assert_semantic_controls(page, expected) {
  const root = page.locator('[data-ink-ui-id="blot.game"]');
  assert.equal(await root.getAttribute("aria-label"), expected.status);
  assert.equal(
    await root.getAttribute("aria-description"),
    expected.description,
  );
  const status = page.locator('[data-ink-ui-id="platformer.status"]');
  assert.equal(await status.textContent(), expected.description);
  assert.equal(
    await status.getAttribute("aria-description"),
    expected.status,
  );
  const controls = page.locator(
    '#semantic-layer button[data-ink-ui-id^="platformer."]',
  );
  assert.equal(await controls.count(), 6);
  for (
    const label of [
      "Move left",
      "Stop left",
      "Move right",
      "Stop right",
      "Jump",
      "Restart",
    ]
  ) {
    const control = page.getByRole("button", { name: label, exact: true });
    assert.equal(await control.count(), 1);
    assert.equal(await control.isEnabled(), true);
  }
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
      throw new Error("platformer screenshot proof has no 2D context");
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

async function capture_completed_level(page) {
  await page.locator("#application").screenshot({
    path: join(artifact_directory, "completed-level.png"),
    timeout: 30_000,
    type: "png",
  });
}

async function capture_render_surface(page) {
  const overlays = page.locator(
    "#semantic-layer, #startup-status, #diagnostics",
  );
  await overlays.evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = "hidden";
  });
  try {
    return await page.locator("#scene").screenshot({
      timeout: 30_000,
      type: "png",
    });
  } finally {
    await overlays.evaluateAll((elements) => {
      for (const element of elements) element.style.visibility = "";
    });
  }
}

async function wait_for_generated_project(expected_source) {
  const generated_project = join(
    generated_directory,
    "platformer-project.json",
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if (await readFile(generated_project, "utf8") === expected_source) return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `platformer Vite build did not publish edited project ${generated_project}`,
  );
}

async function development_evidence(page, selector) {
  return await page.locator(selector).evaluate((application) => ({
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
  selector,
  previous_revision,
  browser_errors,
) {
  try {
    await page.waitForFunction(
      ({ selector, previous_revision }) => {
        const application = document.querySelector(selector);
        return application?.dataset.developmentStatus === "ready" &&
          application.dataset.developmentRevision !== previous_revision &&
          application.dataset.developmentEntryRetained === "true" &&
          application.dataset.developmentStatePreserved === "true";
      },
      { selector, previous_revision },
      { polling: 10 },
    );
  } catch (cause) {
    throw new Error(
      `platformer development activation did not complete: ${
        JSON.stringify({
          evidence: await development_evidence(page, selector),
          browser_errors,
        })
      }`,
      { cause },
    );
  }
  return await development_evidence(page, selector);
}

async function fetch_development_descriptor(origin, artifact_name) {
  const response = await fetch(
    `${origin}/${artifact_name}.development.json`,
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

function build_production_bundle() {
  const built = spawnSync("pnpm", ["build"], {
    cwd: application_directory,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(
    built.status,
    0,
    `platformer production bundle failed:\n${built.stdout}\n${built.stderr}`,
  );
}

async function play_generated_platformer() {
  const level_source = await load_platformer_level_asset({
    name: join(generated_directory, "assets.manifest.json"),
    read_manifest() {
      return readFile(
        join(generated_directory, "assets.manifest.json"),
        "utf8",
      );
    },
    artifacts: {
      async read(location) {
        return new Uint8Array(
          await readFile(join(generated_directory, location)),
        );
      },
    },
  });
  const runtime = await create_platformer_runtime({
    wasm_bytes: new Uint8Array(
      await readFile(join(generated_directory, "platformer_development.wasm")),
    ),
    manifest_source: await readFile(
      join(generated_directory, "platformer_development.wasm.json"),
      "utf8",
    ),
    level_source,
  });
  try {
    return await play_platformer_to_exit(runtime.session);
  } finally {
    await runtime.session.close();
  }
}

function write_scenario_report(assertions) {
  if (process.env.INK_SCENARIO_REPORT === undefined) return;
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
      ...assertions.flatMap((assertion) => ["--passed", assertion]),
    ],
    {
      cwd: application_directory,
      encoding: "utf8",
      env: process.env,
    },
  );
  if (report.error !== undefined) {
    throw new Error("platformer browser report could not start", {
      cause: report.error,
    });
  }
  if (report.status === 0) return;
  const evidence = report.stderr.trim() || report.stdout.trim() ||
    `signal ${report.signal}`;
  throw new Error(
    `platformer browser report exited with ${report.status}: ${evidence}`,
  );
}

function rebuild_starter_artifact() {
  const build = spawnSync("pnpm", ["build:game"], {
    cwd: application_directory,
    encoding: "utf8",
    env: process.env,
  });
  if (build.error !== undefined) {
    throw new Error("platformer starter artifact rebuild could not start", {
      cause: build.error,
    });
  }
  if (build.status === 0) return;
  const evidence = build.stderr.trim() || build.stdout.trim() ||
    `signal ${build.signal}`;
  throw new Error(
    `platformer starter artifact rebuild exited with ${build.status}: ${evidence}`,
  );
}
