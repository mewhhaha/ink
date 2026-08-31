import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer, preview } from "vite";
import {
  parse_vehicle_project,
  serialize_vehicle_project,
} from "@ink/vehicle-editor/serialization.ts";
import {
  parse_vehicle_browser_evidence,
  serialize_vehicle_presentation,
} from "../browser_evidence.ts";
import { append_finish_checkpoint } from "../edit.ts";
import { play_vehicle_course } from "../headless/scenario.ts";
import { create_vehicle_runtime } from "../runtime.ts";

const application_directory = fileURLToPath(new URL("../../", import.meta.url));
const starter_file = fileURLToPath(
  new URL("../../projects/starter.json", import.meta.url),
);
const generated_directory = fileURLToPath(
  new URL("../../generated/", import.meta.url),
);
const artifact_directory = fileURLToPath(
  new URL("../../../../artifacts/vehicle/", import.meta.url),
);
const edited_assertion =
  "browser:edited-finish-checkpoint-rebuilds-and-reloads";
const rejected_assertion = "browser:out-of-order-finish-is-rejected";
const completion_assertion = "browser:ordered-course-completes";
const parity_assertion = "browser:course-matches-headless-presentation";
const pixel_assertion = "browser:completed-course-renders-non-clear-pixels";
const audio_assertion = "browser:authored-course-audio-reaches-host";
const physics_assertion = "browser:physics-blocks-finish-shortcut";

test(
  "the browser rebuilds an appended finish and completes the ordered course",
  { timeout: 120_000 },
  async () => {
    const original_starter = await readFile(starter_file, "utf8");
    const temporary_directory = await mkdtemp(
      join(tmpdir(), "ink-vehicle-browser-"),
    );
    const temporary_project = join(temporary_directory, "starter.json");
    await writeFile(temporary_project, original_starter, "utf8");
    const previous_project_file = process.env.INK_VEHICLE_PROJECT_FILE;
    process.env.INK_VEHICLE_PROJECT_FILE = temporary_project;

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
          `vehicle browser server returned invalid address ${
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
      page.on("requestfailed", (request) => {
        browser_errors.push(
          `${request.method()} ${request.url()} failed: ${
            request.failure()?.errorText ?? "unknown error"
          }`,
        );
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
      await page.goto(origin, {
        waitUntil: "domcontentloaded",
      });
      await wait_for_runtime(page, browser_errors);
      const initial_navigation_count = navigations;
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
      const initial = await browser_evidence(page);
      assert.deepEqual(initial.runtime, { type: "initial" });
      assert_renderer_evidence(initial);
      assert.equal(
        JSON.parse(initial.presentation_source).observation.status.value,
        "Next checkpoint-start · rejected finishes 0",
      );
      assert.equal(
        await page.getByRole("button", { name: /Drive through/ }).count(),
        3,
      );

      const starter = parse_vehicle_project(original_starter);
      const edited = append_finish_checkpoint(starter);
      const edited_source = serialize_vehicle_project(edited);
      await writeFile(temporary_project, edited_source, "utf8");
      await wait_for_generated_project(edited_source);
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
      const rebuilt = await browser_evidence(page);
      assert.deepEqual(rebuilt.runtime, { type: "initial" });
      assert.equal(navigations, initial_navigation_count);
      assert.equal(
        await page.getByRole("button", { name: /Drive through/ }).count(),
        4,
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
          `vehicle production preview returned invalid address ${
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
      assert_renderer_evidence(production_initial);
      assert.equal(
        JSON.parse(production_initial.presentation_source).observation.status
          .value,
        "Next checkpoint-start · rejected finishes 0",
      );
      assert.equal(
        await page.getByRole("button", { name: /Drive through/ }).count(),
        4,
      );
      const production_navigation_count = navigations;

      await activate_checkpoint(page, "finish-line", 1);
      const rejected = await browser_evidence(page);
      const rejected_presentation = JSON.parse(rejected.presentation_source);
      assert.equal(
        rejected_presentation.observation.status.value,
        "Next checkpoint-start · rejected finishes 1",
      );
      assert.deepEqual(rejected.audio, [expected_audio_evidence[0]]);
      assert.match(
        JSON.stringify(rejected_presentation.observation.ui),
        /Shortcut barrier blocked direct finish/,
      );
      assert.match(
        JSON.stringify(rejected_presentation.observation.ui),
        /Canonical collision contacts 1/,
      );
      assert.deepEqual(
        rejected_presentation.snapshot.objects.find(({ id }) => id === 31)
          ?.position,
        [3_000_000, 1_400_000, 6_500_000],
      );

      await activate_checkpoint(page, "start", 2);
      await activate_checkpoint(page, "ridge", 3);
      await activate_checkpoint(page, "tunnel", 4);
      await activate_checkpoint(page, "finish-line", 5);

      const completed = await browser_evidence(page);
      if (completed.runtime.type !== "advanced") {
        throw new Error(
          `completed vehicle runtime evidence was ${completed.runtime.type}`,
        );
      }
      assert.equal(completed.runtime.sequence, 5);
      assert_renderer_evidence(completed);
      assert.match(completed.renderer.center_pick, /^vehicle-object-/);
      assert.deepEqual(completed.observations, {
        capacity: 16,
        retained: 16,
        dropped: completed.observations.dropped,
        redacted_game_text: "[redacted]",
        redacted_debugger_message:
          completed.observations.redacted_debugger_message,
      });
      assert.ok(completed.observations.dropped > 0);
      assert.match(
        completed.observations.redacted_debugger_message,
        /game_text="\[redacted\]"/,
      );
      assert.ok(completed.observations.redacted_debugger_message.length <= 512);
      assert.doesNotMatch(
        completed.observations.redacted_debugger_message,
        /Course complete · checkpoints 4/,
      );
      const diagnostics_output = page.locator("#presentation");
      assert.equal(await diagnostics_output.isVisible(), true);
      const visible_diagnostics = await diagnostics_output.textContent();
      assert.match(visible_diagnostics, /16\/16 observations retained/);
      assert.ok(
        visible_diagnostics.includes(
          completed.observations.redacted_debugger_message,
        ),
      );
      assert.match(visible_diagnostics, /\[redacted\]/);
      assert.doesNotMatch(
        visible_diagnostics,
        /Course complete · checkpoints 4/,
      );
      assert.deepEqual(completed.audio, expected_audio_evidence);
      assert.deepEqual(completed.audio_host, {
        state: "running",
        submitted_cues: expected_audio_evidence.length,
      });

      const completed_presentation = JSON.parse(completed.presentation_source);
      assert.equal(completed_presentation.observation.outcome, "won");
      assert.deepEqual(completed_presentation.observation.status, {
        done: true,
        label: "Storm Pass",
        value: "Course complete · checkpoints 4 · rejected finishes 1",
      });
      assert.equal(completed_presentation.snapshot.camera.type, "perspective");
      assert.equal(
        completed_presentation.snapshot.environment.exposure_ev100,
        0.2,
      );
      assert.deepEqual(completed_presentation.snapshot.directional_light, {
        type: "directional_light",
        color: [0.72, 0.84, 1],
        direction: [-0.42, -1, -0.28],
        intensity: 1.45,
      });
      assert.equal(
        completed_presentation.snapshot.objects.find(({ id }) => id === 30)
          ?.visible,
        true,
      );
      assert.match(
        JSON.stringify(completed_presentation.observation.ui),
        /Finish accepted/,
      );

      await mkdir(artifact_directory, { recursive: true });
      const first_screenshot = await capture_completed_course(page);
      const second_screenshot = await capture_completed_course(page);
      assert.equal(
        image_digest(first_screenshot),
        image_digest(second_screenshot),
      );
      const render_surface = await capture_render_surface(page);
      const coverage = await rendered_coverage(page, render_surface);
      assert.ok(
        coverage.non_clear_fraction > 0.16,
        `vehicle completed-course non-clear coverage ${coverage.non_clear_fraction} must exceed 0.16: ${
          JSON.stringify(coverage)
        }`,
      );
      assert.ok(
        coverage.luminance_range > 18,
        `vehicle completed-course luminance range ${coverage.luminance_range} must exceed 18: ${
          JSON.stringify(coverage)
        }`,
      );

      const headless = await play_generated_vehicle();
      assert.equal(headless.snapshot_checksum, headless.replay_checksum);
      assert.equal(
        completed.runtime.snapshot_checksum,
        headless.snapshot_checksum,
      );
      assert.equal(
        completed.presentation_source,
        serialize_vehicle_presentation(headless.completed),
      );
      assert.equal(
        serialize_vehicle_presentation(headless.replayed),
        serialize_vehicle_presentation(headless.completed),
      );
      assert.deepEqual(headless_audio_evidence(headless), completed.audio);
      assert.deepEqual(browser_errors, []);
      assert.equal(navigations, production_navigation_count);
      write_scenario_report([
        edited_assertion,
        rejected_assertion,
        completion_assertion,
        parity_assertion,
        pixel_assertion,
        audio_assertion,
        physics_assertion,
      ]);
    } finally {
      await browser?.close();
      await server?.close();
      delete process.env.INK_VEHICLE_PROJECT_FILE;
      try {
        await rm(temporary_directory, { recursive: true, force: true });
        rebuild_starter_artifact();
        assert.equal(await readFile(starter_file, "utf8"), original_starter);
      } finally {
        if (previous_project_file !== undefined) {
          process.env.INK_VEHICLE_PROJECT_FILE = previous_project_file;
        }
      }
    }
  },
);

const expected_audio_evidence = [
  { id: "vehicle.finish-rejected", cue: "vehicle.rejected.finish-line" },
  { id: "vehicle.checkpoint-accepted", cue: "vehicle.checkpoint.start" },
  { id: "vehicle.checkpoint-accepted", cue: "vehicle.checkpoint.ridge" },
  { id: "vehicle.checkpoint-accepted", cue: "vehicle.checkpoint.tunnel" },
  { id: "vehicle.course-completed", cue: "vehicle.complete.storm-pass" },
];

async function activate_checkpoint(page, waypoint_id, sequence) {
  await page.getByRole("button", {
    name: `Drive through ${waypoint_id}`,
    exact: true,
  }).click();
  await wait_for_sequence(page, sequence);
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
      `vehicle browser runtime did not settle: ${
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
    `vehicle browser runtime entered state ${JSON.stringify(state)}: ${
      JSON.stringify(browser_errors)
    }`,
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
      `vehicle production runtime did not publish its boundary: ${
        JSON.stringify(browser_errors)
      }`,
      { cause },
    );
  }
}

async function wait_for_sequence(page, sequence) {
  await page.waitForFunction(
    (expected) => {
      const source = document.querySelector("#application")?.getAttribute(
        "data-vehicle-evidence",
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

async function browser_evidence(page) {
  const source = await page.locator("#application").getAttribute(
    "data-vehicle-evidence",
  );
  if (source === null) {
    throw new Error("vehicle browser did not publish typed evidence");
  }
  return parse_vehicle_browser_evidence(source);
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
      throw new Error("vehicle screenshot proof has no 2D context");
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

async function capture_completed_course(page) {
  return await page.locator("#application").screenshot({
    path: join(artifact_directory, "completed-course.png"),
    timeout: 30_000,
    type: "png",
  });
}

async function capture_render_surface(page) {
  const overlays = page.locator("#semantic-layer, #status, #presentation");
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
  const generated_project = join(generated_directory, "vehicle-project.json");
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
    `vehicle Vite build did not publish edited project ${generated_project}`,
  );
}

async function development_evidence(page) {
  return await page.locator("#application").evaluate((application) => ({
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
        const application = document.querySelector("#application");
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
      `vehicle development activation did not complete: ${
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
    `${origin}/vehicle_development.development.json`,
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

function image_digest(image) {
  return createHash("sha256").update(image).digest("hex");
}

async function play_generated_vehicle() {
  const runtime = await create_vehicle_runtime({
    wasm_bytes: new Uint8Array(
      await readFile(join(generated_directory, "vehicle_development.wasm")),
    ),
    manifest_source: await readFile(
      join(generated_directory, "vehicle_development.wasm.json"),
      "utf8",
    ),
  });
  try {
    return await play_vehicle_course(runtime.session);
  } finally {
    await runtime.session.close();
  }
}

function headless_audio_evidence(playthrough) {
  return [
    playthrough.early_finish,
    playthrough.start,
    playthrough.ridge,
    playthrough.tunnel,
    playthrough.completed,
  ].flatMap(({ effects }) =>
    effects.map(({ id, cue }) => ({ id, cue: String(cue) }))
  );
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
    throw new Error("vehicle browser report could not start", {
      cause: report.error,
    });
  }
  if (report.status === 0) return;
  const evidence = report.stderr.trim() || report.stdout.trim() ||
    `signal ${report.signal}`;
  throw new Error(
    `vehicle browser report exited with ${report.status}: ${evidence}`,
  );
}

function build_production_bundle() {
  const build = spawnSync("pnpm", ["build"], {
    cwd: application_directory,
    encoding: "utf8",
    env: process.env,
  });
  if (build.error !== undefined) {
    throw new Error("vehicle production bundle could not start", {
      cause: build.error,
    });
  }
  if (build.status === 0) return;
  const evidence = build.stderr.trim() || build.stdout.trim() ||
    `signal ${build.signal}`;
  throw new Error(
    `vehicle production bundle exited with ${build.status}: ${evidence}`,
  );
}

function rebuild_starter_artifact() {
  const build = spawnSync("pnpm", ["build:game"], {
    cwd: application_directory,
    encoding: "utf8",
    env: process.env,
  });
  if (build.error !== undefined) {
    throw new Error("vehicle starter artifact rebuild could not start", {
      cause: build.error,
    });
  }
  if (build.status === 0) return;
  const evidence = build.stderr.trim() || build.stdout.trim() ||
    `signal ${build.signal}`;
  throw new Error(
    `vehicle starter artifact rebuild exited with ${build.status}: ${evidence}`,
  );
}
