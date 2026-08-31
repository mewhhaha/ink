import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer, preview } from "vite";
import {
  parse_roleplaying_project,
  serialize_roleplaying_project,
} from "@ink/roleplaying-editor/serialization.ts";
import {
  parse_roleplaying_browser_evidence,
  serialize_roleplaying_presentation,
} from "../browser_evidence.ts";
import { add_roleplaying_loot_entry } from "../edit.ts";
import { play_roleplaying_to_shrine } from "../headless/scenario.ts";
import { create_roleplaying_runtime } from "../runtime.ts";

const application_directory = fileURLToPath(new URL("../../", import.meta.url));
const starter_file = fileURLToPath(
  new URL("../../projects/starter.json", import.meta.url),
);
const generated_directory = fileURLToPath(
  new URL("../../generated/", import.meta.url),
);
const artifact_directory = fileURLToPath(
  new URL("../../../../artifacts/roleplaying/", import.meta.url),
);
const edited_loot_assertion = "browser:edited-ruins-loot-rebuilds-and-reloads";
const parity_assertion =
  "browser:ruins-pilgrimage-matches-headless-presentation";
const audio_assertion = "browser:canonical-audio-host-accepts-authored-cues";
const visual_assertion = "browser:final-shrine-renders-non-clear-pixels";
const timeline_assertion =
  "browser:authored-timeline-rejects-out-of-order-and-early-actions";

test(
  "the browser rebuilds edited ruins loot and matches the headless pilgrimage",
  { timeout: 120_000 },
  async () => {
    const original_starter = await readFile(starter_file, "utf8");
    const temporary_directory = await mkdtemp(
      join(tmpdir(), "ink-roleplaying-browser-"),
    );
    const temporary_project = join(temporary_directory, "starter.json");
    await writeFile(temporary_project, original_starter, "utf8");
    const previous_project_file = process.env.INK_ROLEPLAYING_PROJECT_FILE;
    process.env.INK_ROLEPLAYING_PROJECT_FILE = temporary_project;

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
          `role-playing browser server returned invalid address ${
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
        "Village Keeper waits by the ruins road",
      );

      const starter = parse_roleplaying_project(original_starter);
      const edited = add_roleplaying_loot_entry(
        starter,
        "ruins-cache",
        "moonstone-relic",
      );
      const edited_source = serialize_roleplaying_project(edited);
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

      const timeline_guards = await browser_timeline_guard_evidence(page);
      assert.deepEqual(timeline_guards.out_of_order, {
        status: {
          done: false,
          label: "Keeper's Village",
          value: "Village Keeper waits by the ruins road",
        },
        effects: [],
      });
      assert.deepEqual(timeline_guards.too_early, {
        status: {
          done: false,
          label: "Keeper's Village",
          value: "Village Keeper waits by the ruins road",
        },
        effects: [],
      });
      assert.equal(
        timeline_guards.on_time.status.value,
        "Travel to Old Ruins",
      );
      assert.deepEqual(timeline_guards.on_time.effects, [{
        type: "play_audio",
        id: "roleplaying.talk",
        cue: "roleplaying.keeper-greeting",
      }]);

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
          `role-playing production preview returned invalid address ${
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
        "Village Keeper waits by the ruins road",
      );
      const production_navigation_count = navigations;

      await activate(page, "Talk to Village Keeper", 2);
      await activate(page, "Travel to Old Ruins", 4);
      await activate(page, "Attack Ruins Sentinel", 6);
      assert.equal(
        JSON.parse((await browser_evidence(page)).presentation_source)
          .observation.status.value,
        "Ruins Sentinel health 2",
      );
      await activate(page, "Attack Ruins Sentinel", 8);
      await activate(page, "Collect moonstone-relic", 10);
      await activate(page, "Travel to Sunken Shrine", 12);

      const completed = await browser_evidence(page);
      if (completed.runtime.type !== "advanced") {
        throw new Error(
          `completed role-playing runtime evidence was ${completed.runtime.type}`,
        );
      }
      assert.equal(completed.runtime.sequence, 12);
      assert_renderer_evidence(completed);
      assert.equal(completed.renderer.center_pick, "roleplaying-object-10");
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
      assert.ok(
        completed.observations.redacted_debugger_message.length <= 512,
      );
      assert.doesNotMatch(
        completed.observations.redacted_debugger_message,
        /moonstone-relic offered at Sunken Shrine/,
      );
      const visible_diagnostics = await page.locator("#presentation")
        .textContent();
      assert.match(visible_diagnostics, /16\/16 observations retained/);
      assert.ok(
        visible_diagnostics.includes(
          completed.observations.redacted_debugger_message,
        ),
      );
      assert.match(visible_diagnostics, /\[redacted\]/);
      assert.doesNotMatch(
        visible_diagnostics,
        /moonstone-relic offered at Sunken Shrine/,
      );
      assert.deepEqual(completed.audio, expected_audio_evidence);
      assert.deepEqual(completed.audio_host, {
        accepted: expected_audio_evidence.map(({ cue }, sequence) => ({
          cue,
          sequence,
        })),
        command_capacity: 6,
        retained_commands: 0,
        state: "running",
      });

      const completed_presentation = JSON.parse(completed.presentation_source);
      assert.equal(completed_presentation.observation.outcome, "won");
      assert.deepEqual(completed_presentation.observation.status, {
        done: true,
        label: "The Sentinel Road",
        value: "moonstone-relic offered at Sunken Shrine",
      });
      assert.equal(completed_presentation.snapshot.camera.type, "perspective");
      assert.equal(
        completed_presentation.snapshot.environment.exposure_ev100,
        -0.25,
      );
      assert.deepEqual(completed_presentation.snapshot.directional_light, {
        type: "directional_light",
        color: [0.42, 0.7, 1],
        direction: [0.25, -1, -0.15],
        intensity: 1.4,
      });
      assert.equal(
        completed_presentation.snapshot.objects.find(({ id }) => id === 14)
          ?.visible,
        true,
      );
      assert.match(
        JSON.stringify(completed_presentation.observation.ui),
        /moonstone-relic offered at Sunken Shrine/,
      );
      await mkdir(artifact_directory, { recursive: true });
      const render_surface = await capture_final_shrine(page);
      const coverage = await rendered_coverage(page, render_surface);
      assert.ok(
        coverage.non_clear_fraction > 0.2,
        `role-playing final-shrine non-clear coverage ${coverage.non_clear_fraction} must exceed 0.2: ${
          JSON.stringify(coverage)
        }`,
      );
      assert.ok(
        coverage.luminance_range > 20,
        `role-playing final-shrine luminance range ${coverage.luminance_range} must exceed 20: ${
          JSON.stringify(coverage)
        }`,
      );

      const headless = await play_generated_roleplaying();
      assert.equal(headless.snapshot_checksum, headless.replay_checksum);
      assert.equal(
        completed.runtime.snapshot_checksum,
        headless.snapshot_checksum,
      );
      assert.equal(
        completed.presentation_source,
        serialize_roleplaying_presentation(headless.completed),
      );
      assert.equal(
        serialize_roleplaying_presentation(headless.replayed),
        serialize_roleplaying_presentation(headless.completed),
      );
      assert.deepEqual(headless_audio_evidence(headless), completed.audio);
      assert.deepEqual(browser_errors, []);
      assert.equal(navigations, production_navigation_count);
      write_scenario_report([
        edited_loot_assertion,
        parity_assertion,
        audio_assertion,
        visual_assertion,
        timeline_assertion,
      ]);
    } finally {
      await browser?.close();
      await server?.close();
      delete process.env.INK_ROLEPLAYING_PROJECT_FILE;
      try {
        await rm(temporary_directory, { recursive: true, force: true });
        rebuild_starter_artifact();
        assert.equal(await readFile(starter_file, "utf8"), original_starter);
      } finally {
        if (previous_project_file !== undefined) {
          process.env.INK_ROLEPLAYING_PROJECT_FILE = previous_project_file;
        }
      }
    }
  },
);

const expected_audio_evidence = [
  { id: "roleplaying.talk", cue: "roleplaying.keeper-greeting" },
  { id: "roleplaying.travel-ruins", cue: "roleplaying.travel-ruins" },
  { id: "roleplaying.strike", cue: "roleplaying.strike" },
  {
    id: "roleplaying.sentinel-defeated",
    cue: "roleplaying.ruins-guard",
  },
  { id: "roleplaying.loot-collected", cue: "roleplaying.ruins-cache" },
  { id: "roleplaying.shrine-reached", cue: "roleplaying.reach-shrine" },
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
    }));
    throw new Error(
      `role-playing browser runtime did not settle: ${
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
    `role-playing browser runtime entered state ${JSON.stringify(state)}: ${
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
      `role-playing production runtime did not publish its boundary: ${
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
        "data-roleplaying-evidence",
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
    "data-roleplaying-evidence",
  );
  if (source === null) {
    throw new Error("role-playing browser did not publish typed evidence");
  }
  return parse_roleplaying_browser_evidence(source);
}

async function browser_timeline_guard_evidence(page) {
  return await page.evaluate(async () => {
    const [
      { create_roleplaying_runtime },
      { probe_roleplaying_timeline_guards },
    ] = await Promise.all([
      import("/src/runtime.ts"),
      import("/src/headless/scenario.ts"),
    ]);
    const [wasm_response, manifest_response] = await Promise.all([
      fetch("/roleplaying_development.wasm", { cache: "no-store" }),
      fetch("/roleplaying_development.wasm.json", { cache: "no-store" }),
    ]);
    if (!wasm_response.ok || !manifest_response.ok) {
      throw new Error(
        `role-playing timeline probe returned Wasm ${wasm_response.status} and manifest ${manifest_response.status}`,
      );
    }
    const runtime = await create_roleplaying_runtime({
      wasm_bytes: new Uint8Array(await wasm_response.arrayBuffer()),
      manifest_source: await manifest_response.text(),
    });
    try {
      const evidence = await probe_roleplaying_timeline_guards(runtime.session);
      return Object.fromEntries(
        Object.entries(evidence).map(([name, presentation]) => [name, {
          status: presentation.observation.status,
          effects: presentation.effects,
        }]),
      );
    } finally {
      await runtime.session.close();
    }
  });
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
      throw new Error("role-playing screenshot proof has no 2D context");
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

async function capture_final_shrine(page) {
  const overlays = page.locator("#semantic-layer, #status, #presentation");
  await overlays.evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = "hidden";
  });
  try {
    return await page.locator("#scene").screenshot({
      path: `${artifact_directory}/final-shrine.png`,
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
    "roleplaying-project.json",
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
    `role-playing Vite build did not publish edited project ${generated_project}`,
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
      `role-playing development activation did not complete: ${
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
    `${origin}/roleplaying_development.development.json`,
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

async function play_generated_roleplaying() {
  const runtime = await create_roleplaying_runtime({
    wasm_bytes: new Uint8Array(
      await readFile(
        join(generated_directory, "roleplaying_development.wasm"),
      ),
    ),
    manifest_source: await readFile(
      join(generated_directory, "roleplaying_development.wasm.json"),
      "utf8",
    ),
  });
  try {
    return await play_roleplaying_to_shrine(runtime.session);
  } finally {
    await runtime.session.close();
  }
}

function headless_audio_evidence(playthrough) {
  return [
    playthrough.talked,
    playthrough.arrived_at_ruins,
    playthrough.first_strike,
    playthrough.sentinel_defeated,
    playthrough.loot_collected,
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
    throw new Error("role-playing browser report could not start", {
      cause: report.error,
    });
  }
  if (report.status === 0) return;
  const evidence = report.stderr.trim() || report.stdout.trim() ||
    `signal ${report.signal}`;
  throw new Error(
    `role-playing browser report exited with ${report.status}: ${evidence}`,
  );
}

function build_production_bundle() {
  const build = spawnSync("pnpm", ["build"], {
    cwd: application_directory,
    encoding: "utf8",
    env: process.env,
  });
  if (build.error !== undefined) {
    throw new Error("role-playing production bundle could not start", {
      cause: build.error,
    });
  }
  if (build.status === 0) return;
  const evidence = build.stderr.trim() || build.stdout.trim() ||
    `signal ${build.signal}`;
  throw new Error(
    `role-playing production bundle exited with ${build.status}: ${evidence}`,
  );
}

function rebuild_starter_artifact() {
  const build = spawnSync("pnpm", ["build:game"], {
    cwd: application_directory,
    encoding: "utf8",
    env: process.env,
  });
  if (build.error !== undefined) {
    throw new Error("role-playing starter artifact rebuild could not start", {
      cause: build.error,
    });
  }
  if (build.status === 0) return;
  const evidence = build.stderr.trim() || build.stdout.trim() ||
    `signal ${build.signal}`;
  throw new Error(
    `role-playing starter artifact rebuild exited with ${build.status}: ${evidence}`,
  );
}
