import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer, preview } from "vite";
import { create_strategy_starter } from "@ink/strategy-editor/presets.ts";
import { serialize_strategy_project } from "@ink/strategy-editor/serialization.ts";
import {
  parse_strategy_browser_evidence,
  serialize_strategy_presentation,
} from "../browser_evidence.ts";
import {
  add_player_barracks_and_scout_route,
  expand_strategy_map_for_failed_activation,
} from "../edit.ts";
import { play_strategy_to_victory } from "../headless/scenario.ts";
import { create_strategy_runtime } from "../runtime.ts";

const application_directory = fileURLToPath(new URL("../../", import.meta.url));
const generated_directory = join(application_directory, "generated");
const artifact_directory = fileURLToPath(
  new URL("../../../../artifacts/strategy/", import.meta.url),
);
const descriptor_file = join(
  application_directory,
  "generated",
  "strategy_development.development.json",
);
const assertions = [
  "browser:editor-barracks-route-retained-activation-and-rollback",
  "browser:early-attack-rejected",
  "browser:trained-scouts-traverse-route-and-destroy-headquarters",
  "browser:headless-replay-presentation-parity",
  "browser:nonfallback-webgpu-pixels-pick-and-redaction",
  "browser:authored-audio-cues-reach-host",
];

test(
  "the browser atomically rebuilds the edited strategy and wins the authored battle",
  { timeout: 180_000 },
  async () => {
    const temporary_directory = await mkdtemp(
      join(application_directory, ".strategy-browser-"),
    );
    const temporary_source = join(temporary_directory, "src", "blot");
    const temporary_project = join(
      temporary_directory,
      "projects",
      "starter.json",
    );
    const temporary_manifest = join(temporary_directory, "blot.json");
    const temporary_provider = join(
      temporary_source,
      "generated",
      "project.blot",
    );
    await Promise.all([
      mkdir(join(temporary_source, "game"), { recursive: true }),
      mkdir(join(temporary_source, "generated"), { recursive: true }),
      mkdir(join(temporary_directory, "projects"), { recursive: true }),
    ]);
    const starter = create_strategy_starter("real-time-strategy");
    const starter_source = serialize_strategy_project(starter);
    await Promise.all([
      copyFile(
        join(application_directory, "blot.json"),
        temporary_manifest,
      ),
      copyFile(
        join(application_directory, "src", "blot", "game", "main.blot"),
        join(temporary_source, "game", "main.blot"),
      ),
      copyFile(
        join(application_directory, "src", "blot", "prelude.blot"),
        join(temporary_source, "prelude.blot"),
      ),
      writeFile(temporary_project, starter_source, "utf8"),
    ]);
    const edited = add_player_barracks_and_scout_route(starter);
    const edited_source = serialize_strategy_project(edited);
    const expanded_source = serialize_strategy_project(
      expand_strategy_map_for_failed_activation(edited),
    );
    const previous_project = process.env.INK_STRATEGY_PROJECT_FILE;
    const previous_root = process.env.INK_STRATEGY_DEVELOPMENT_ROOT;
    const previous_descriptor = await read_optional_file(descriptor_file);
    process.env.INK_STRATEGY_PROJECT_FILE = temporary_project;
    process.env.INK_STRATEGY_DEVELOPMENT_ROOT = temporary_directory;

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
          `strategy browser server returned invalid address ${
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
      page.on(
        "pageerror",
        (error) => browser_errors.push(error.stack ?? error.message),
      );
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
      page.on("crash", () => browser_errors.push("strategy page crashed"));
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await wait_for_runtime(page, browser_errors);
      const initial_development = await wait_for_development(page, {
        type: "ready",
      }, browser_errors);
      assert.equal(initial_development.entry_retained, false);
      const initial_descriptor = await fetch_descriptor(origin);
      assert_development_revision(initial_descriptor, {
        base_revision: null,
        changed_units: ["game", "project"],
        retained_units: [],
      });
      const initial = await browser_evidence(page);
      assert_renderer_evidence(initial);
      assert.equal(
        JSON.parse(initial.presentation_source).observation.status.value,
        "Author a scout barracks and route",
      );
      const raw_surface = await capture_render_surface(page);

      await page.getByRole("button", {
        name: "Attack headquarters",
        exact: true,
      }).click();
      await wait_for_sequence(page, 1);
      const raw_rejected = await browser_evidence(page);
      assert.deepEqual(raw_rejected.audio, [{
        id: "strategy.attack-rejected",
        cue: "strategy.attack.rejected",
      }]);

      await writeFile(temporary_project, edited_source, "utf8");
      const activated = await wait_for_development(page, {
        type: "ready",
        previous_revision: initial_development.revision,
        status_value: "Attack rejected · train 3 scouts and finish the route",
      }, browser_errors);
      assert.equal(activated.entry_retained, true);
      assert.match(
        await readFile(temporary_provider, "utf8"),
        /scout-route-point-4/,
      );
      const activated_descriptor = await fetch_descriptor(origin);
      assert_development_revision(activated_descriptor, {
        base_revision: initial_development.revision,
        changed_units: ["project"],
        retained_units: ["game"],
      });

      let corrupt_next_wasm = true;
      await page.route(
        /\/\.ink\/blot\/[a-f0-9]{64}\.wasm(?:\?.*)?$/,
        async (route) => {
          if (!corrupt_next_wasm) {
            await route.continue();
            return;
          }
          corrupt_next_wasm = false;
          await route.fulfill({
            status: 200,
            contentType: "application/wasm",
            body: Buffer.from([0]),
          });
        },
      );
      await writeFile(temporary_project, expanded_source, "utf8");
      const failed = await wait_for_development(page, {
        type: "failed",
        status_value: "Attack rejected · train 3 scouts and finish the route",
      }, browser_errors);
      assert.equal(failed.revision, activated.revision);
      assert.equal(corrupt_next_wasm, false);
      const failed_presentation = await browser_evidence(page);
      assert.equal(
        JSON.parse(failed_presentation.presentation_source).observation.status
          .value,
        "Attack rejected · train 3 scouts and finish the route",
      );

      await writeFile(temporary_project, edited_source, "utf8");
      const recovered = await wait_for_development(page, {
        type: "ready",
        revision: activated.revision,
        status_value: "Attack rejected · train 3 scouts and finish the route",
      }, browser_errors);
      assert.equal(recovered.entry_retained, true);

      await page.reload({ waitUntil: "domcontentloaded" });
      await wait_for_runtime(page, browser_errors);
      await wait_for_development(page, { type: "ready" }, browser_errors);
      const rebuilt = await browser_evidence(page);
      assert.equal(
        JSON.parse(rebuilt.presentation_source).observation.status.value,
        "Train 3 scouts, follow every waypoint, then attack",
      );
      const edited_surface = await capture_render_surface(page);
      assert.notEqual(image_digest(raw_surface), image_digest(edited_surface));

      await server.close();
      server = undefined;
      build_edited_production_bundle(temporary_project);
      assert_production_bundle_excludes_compiler_runtime();
      server = await preview({
        build: { outDir: join(application_directory, "dist") },
        configFile: false,
        logLevel: "silent",
        preview: { host: "127.0.0.1", port: 0 },
        root: application_directory,
      });
      const preview_address = server.httpServer.address();
      if (
        typeof preview_address !== "object" || preview_address === null ||
        !Number.isSafeInteger(preview_address.port) || preview_address.port <= 0
      ) {
        throw new Error(
          `strategy production preview returned invalid address ${
            JSON.stringify(preview_address)
          }`,
        );
      }
      const production_origin = `http://127.0.0.1:${preview_address.port}`;
      await page.goto(production_origin, { waitUntil: "domcontentloaded" });
      await wait_for_runtime(page, browser_errors);
      await wait_for_development(page, { type: "production" }, browser_errors);
      const production = await browser_evidence(page);
      assert.equal(
        JSON.parse(production.presentation_source).observation.status.value,
        "Train 3 scouts, follow every waypoint, then attack",
      );
      assert_renderer_evidence(production);

      await activate(page, "Attack headquarters", 1);
      const early_attack = await browser_evidence(page);
      assert.equal(
        JSON.parse(early_attack.presentation_source).observation.status.value,
        "Attack rejected · train 3 scouts and finish the route",
      );
      for (let scout = 1; scout <= 3; scout += 1) {
        await activate(page, "Train scout", 1 + scout);
      }
      for (let point = 1; point <= 4; point += 1) {
        await activate(page, `March to waypoint ${point}`, 4 + point);
      }
      await activate(page, "Attack headquarters", 9);
      await activate(page, "Attack headquarters", 10);
      await activate(page, "Attack headquarters", 11);

      const completed = await browser_evidence(page);
      if (completed.runtime.type !== "advanced") {
        throw new Error(
          `completed strategy runtime evidence was ${completed.runtime.type}`,
        );
      }
      assert.equal(completed.runtime.sequence, 11);
      assert_renderer_evidence(completed);
      assert.match(completed.renderer.center_pick, /^strategy-object-/);
      assert.equal(completed.observations.capacity, 24);
      assert.equal(completed.observations.retained, 24);
      assert.ok(completed.observations.dropped > 0);
      assert.equal(completed.observations.redacted_game_text, "[redacted]");
      assert.match(
        completed.observations.redacted_debugger_message,
        /game_text="\[redacted\]"/,
      );
      assert.doesNotMatch(
        completed.observations.redacted_debugger_message,
        /Opposing headquarters destroyed/,
      );
      const diagnostics_output = page.locator("#presentation");
      assert.equal(await diagnostics_output.isVisible(), true);
      const visible_diagnostics = await diagnostics_output.textContent();
      assert.match(visible_diagnostics, /24\/24 observations retained/);
      assert.ok(
        visible_diagnostics.includes(
          completed.observations.redacted_debugger_message,
        ),
      );
      assert.match(visible_diagnostics, /\[redacted\]/);
      assert.doesNotMatch(
        visible_diagnostics,
        /Opposing headquarters destroyed/,
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
        label: "Real-time Strategy Starter",
        value: "Opposing headquarters destroyed · travel seconds 9",
      });
      assert.equal(completed_presentation.snapshot.camera.type, "perspective");
      assert.equal(
        completed_presentation.snapshot.environment.exposure_ev100,
        0.15,
      );
      assert.deepEqual(completed_presentation.snapshot.directional_light, {
        type: "directional_light",
        color: [1, 0.86, 0.68],
        direction: [-0.42, -1, -0.28],
        intensity: 1.45,
      });
      assert.equal(
        completed_presentation.snapshot.objects.find(({ id }) => id === 11)
          ?.visible,
        false,
      );
      assert.equal(
        completed_presentation.snapshot.objects.find(({ id }) => id === 30)
          ?.visible,
        true,
      );

      await mkdir(artifact_directory, { recursive: true });
      const first_screenshot = await capture_completed_strategy(page);
      const second_screenshot = await capture_completed_strategy(page);
      assert.equal(
        image_digest(first_screenshot),
        image_digest(second_screenshot),
      );
      const render_surface = await capture_render_surface(page);
      const coverage = await rendered_coverage(page, render_surface);
      assert.ok(
        coverage.non_clear_fraction > 0.12,
        `strategy non-clear coverage ${coverage.non_clear_fraction} must exceed 0.12: ${
          JSON.stringify(coverage)
        }`,
      );
      assert.ok(
        coverage.luminance_range > 16,
        `strategy luminance range ${coverage.luminance_range} must exceed 16: ${
          JSON.stringify(coverage)
        }`,
      );

      const headless = await play_generated_strategy();
      assert.equal(headless.snapshot_checksum, headless.replay_checksum);
      assert.equal(
        completed.runtime.snapshot_checksum,
        headless.snapshot_checksum,
      );
      assert.equal(
        completed.presentation_source,
        serialize_strategy_presentation(headless.completed),
      );
      assert.equal(
        serialize_strategy_presentation(headless.replayed),
        serialize_strategy_presentation(headless.completed),
      );
      assert.deepEqual(headless_audio_evidence(headless), completed.audio);
      assert.deepEqual(browser_errors, []);
      write_scenario_report(assertions);
    } finally {
      await browser?.close();
      await server?.close();
      restore_environment(
        "INK_STRATEGY_PROJECT_FILE",
        previous_project,
      );
      restore_environment(
        "INK_STRATEGY_DEVELOPMENT_ROOT",
        previous_root,
      );
      try {
        if (previous_descriptor === undefined) {
          await rm(descriptor_file, { force: true });
        } else {
          await writeFile(descriptor_file, previous_descriptor);
        }
        rebuild_starter_artifact();
      } finally {
        await rm(temporary_directory, { recursive: true, force: true });
      }
    }
  },
);

const expected_audio_evidence = [
  { id: "strategy.attack-rejected", cue: "strategy.attack.rejected" },
  { id: "strategy.train", cue: "strategy.train.scout" },
  { id: "strategy.train", cue: "strategy.train.scout" },
  { id: "strategy.train", cue: "strategy.train.scout" },
  { id: "strategy.route", cue: "strategy.route.scout-route-point-1" },
  { id: "strategy.route", cue: "strategy.route.scout-route-point-2" },
  { id: "strategy.route", cue: "strategy.route.scout-route-point-3" },
  { id: "strategy.route", cue: "strategy.route.scout-route-point-4" },
  { id: "strategy.attack", cue: "strategy.attack.headquarters" },
  { id: "strategy.attack", cue: "strategy.attack.headquarters" },
  {
    id: "strategy.headquarters-destroyed",
    cue: "strategy.complete.destroy-headquarters",
  },
];

async function activate(page, label, sequence) {
  await page.getByRole("button", { name: label, exact: true }).click();
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
      development: element.getAttribute("data-development-evidence"),
    }));
    throw new Error(
      `strategy runtime did not settle: ${
        JSON.stringify({ diagnostics, browser_errors })
      }`,
      { cause },
    );
  }
  const state = await page.locator("#application").getAttribute(
    "data-runtime-state",
  );
  if (state === "ready") return;
  throw new Error(
    `strategy runtime entered state ${JSON.stringify(state)}: ${
      JSON.stringify(browser_errors)
    }`,
  );
}

async function wait_for_development(page, expected, browser_errors) {
  try {
    await page.waitForFunction(
      (target) => {
        const source = document.querySelector("#application")?.getAttribute(
          "data-development-evidence",
        );
        if (source === null || source === undefined) return false;
        const evidence = JSON.parse(source);
        return evidence.type === target.type &&
          (target.status_value === undefined ||
            evidence.status_value === target.status_value) &&
          (target.revision === undefined ||
            evidence.revision === target.revision) &&
          (target.previous_revision === undefined ||
            evidence.revision !== target.previous_revision);
      },
      expected,
      { polling: 10 },
    );
  } catch (cause) {
    const diagnostics = await page.locator("#application").evaluate((
      element,
    ) => ({
      development: element.getAttribute("data-development-evidence"),
      runtime: element.getAttribute("data-strategy-evidence"),
      status: element.querySelector("#status")?.textContent,
    }));
    throw new Error(
      `strategy development did not reach ${JSON.stringify(expected)}: ${
        JSON.stringify({ diagnostics, browser_errors })
      }`,
      { cause },
    );
  }
  return await page.locator("#application").evaluate((element) =>
    JSON.parse(element.getAttribute("data-development-evidence"))
  );
}

async function wait_for_sequence(page, sequence) {
  await page.waitForFunction(
    (expected) => {
      const source = document.querySelector("#application")?.getAttribute(
        "data-strategy-evidence",
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
    "data-strategy-evidence",
  );
  if (source === null) {
    throw new Error("strategy browser did not publish typed evidence");
  }
  return parse_strategy_browser_evidence(source);
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

async function fetch_descriptor(origin) {
  const response = await fetch(
    `${origin}/strategy_development.development.json?test=${crypto.randomUUID()}`,
    { cache: "no-store" },
  );
  assert.equal(response.status, 200);
  return await response.json();
}

function assert_development_revision(
  descriptor,
  { base_revision, changed_units, retained_units },
) {
  assert.equal(descriptor.format, "ink-blot-development-revision");
  assert.equal(descriptor.version, 1);
  assert.equal(descriptor.snapshot.entry_unit, "game");
  assert.deepEqual(
    descriptor.snapshot.units.map(({ name }) => name),
    ["game", "project"],
  );
  assert.deepEqual(
    descriptor.snapshot.edges.map(({ consumer, provider }) => ({
      consumer,
      provider,
    })),
    [{ consumer: "game", provider: "project" }],
  );
  assert.equal(descriptor.delta.base_revision, base_revision);
  assert.deepEqual(
    descriptor.delta.changed_units.map(({ name }) => name),
    changed_units,
  );
  assert.deepEqual(
    descriptor.delta.retained_units.map(({ name }) => name),
    retained_units,
  );
  assert.deepEqual(descriptor.delta.removed_units, []);
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
      throw new Error("strategy screenshot proof has no 2D context");
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

async function capture_completed_strategy(page) {
  return await page.locator("#application").screenshot({
    path: join(artifact_directory, "final-headquarters.png"),
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

function image_digest(image) {
  return createHash("sha256").update(image).digest("hex");
}

function headless_audio_evidence(playthrough) {
  return [
    playthrough.early_attack,
    ...playthrough.trained,
    ...playthrough.route,
    ...playthrough.headquarters_hits,
    playthrough.completed,
  ].flatMap(({ effects }) =>
    effects.map(({ id, cue }) => ({ id, cue: String(cue) }))
  );
}

async function play_generated_strategy() {
  const runtime = await create_strategy_runtime({
    wasm_bytes: new Uint8Array(
      await readFile(join(generated_directory, "strategy_development.wasm")),
    ),
    manifest_source: await readFile(
      join(generated_directory, "strategy_development.wasm.json"),
      "utf8",
    ),
  });
  try {
    return await play_strategy_to_victory(runtime.session);
  } finally {
    await runtime.session.close();
  }
}

function build_edited_production_bundle(project_file) {
  const build = spawnSync("pnpm", ["build"], {
    cwd: application_directory,
    encoding: "utf8",
    env: {
      ...process.env,
      INK_STRATEGY_PROJECT_FILE: project_file,
      INK_STRATEGY_DEVELOPMENT_ROOT: application_directory,
    },
  });
  assert_successful_command(build, "strategy edited production bundle");
}

function rebuild_starter_artifact() {
  const environment = { ...process.env };
  delete environment.INK_STRATEGY_PROJECT_FILE;
  delete environment.INK_STRATEGY_DEVELOPMENT_ROOT;
  const build = spawnSync("pnpm", ["build:game"], {
    cwd: application_directory,
    encoding: "utf8",
    env: environment,
  });
  assert_successful_command(build, "strategy starter artifact rebuild");
}

function assert_production_bundle_excludes_compiler_runtime() {
  const bundle = spawnSync(
    "rg",
    ["-l", "DevelopmentRuntime|prepareActivation|compiler\\.wasm", "dist"],
    { cwd: application_directory, encoding: "utf8" },
  );
  if (bundle.error !== undefined) {
    throw new Error("strategy bundle inspection could not start", {
      cause: bundle.error,
    });
  }
  assert.equal(bundle.status, 1, bundle.stdout || bundle.stderr);
}

function write_scenario_report(passed_assertions) {
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
      ...passed_assertions.flatMap((assertion) => ["--passed", assertion]),
    ],
    {
      cwd: application_directory,
      encoding: "utf8",
      env: process.env,
    },
  );
  assert_successful_command(report, "strategy browser report");
}

function assert_successful_command(command, label) {
  if (command.error !== undefined) {
    throw new Error(`${label} could not start`, { cause: command.error });
  }
  if (command.status === 0) return;
  const evidence = command.stderr.trim() || command.stdout.trim() ||
    `signal ${command.signal}`;
  throw new Error(`${label} exited with ${command.status}: ${evidence}`);
}

async function read_optional_file(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function restore_environment(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
