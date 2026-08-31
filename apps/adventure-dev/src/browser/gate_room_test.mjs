import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

const application_directory = fileURLToPath(new URL("../../", import.meta.url));
const artifact_directory = fileURLToPath(
  new URL("../../../../artifacts/adventure/", import.meta.url),
);
const viewport = { width: 960, height: 540 };

test(
  "the production gate room has deterministic raster and path-traced play",
  { timeout: 180_000 },
  async () => {
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
          `adventure browser server returned invalid address ${
            JSON.stringify(address)
          }`,
        );
      }
      await wait_for_prepared_manifest(
        `http://127.0.0.1:${address.port}/assets.manifest.json`,
      );

      browser = await chromium.launch({
        headless: true,
        args: [
          "--enable-unsafe-webgpu",
          "--enable-features=Vulkan",
          "--use-angle=vulkan",
        ],
      });
      const page = await browser.newPage({ viewport });
      await install_frame_control(page);
      const browser_errors = [];
      const requests = [];
      const request_generations = new WeakMap();
      let application_generation = 0;
      page.on("crash", () => browser_errors.push("page crashed"));
      page.on("pageerror", (error) => browser_errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") browser_errors.push(message.text());
      });
      page.on("requestfailed", (request) => {
        browser_errors.push(
          `request ${request.url()} failed: ${request.failure()?.errorText}`,
        );
      });
      page.on("response", (response) => {
        if (response.status() >= 400) {
          browser_errors.push(
            `request ${response.url()} returned ${response.status()}`,
          );
        }
      });
      page.on("request", (request) => {
        request_generations.set(request, application_generation);
      });
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) application_generation += 1;
      });
      page.on("requestfinished", async (request) => {
        const response = await request.response();
        requests.push({
          generation: request_generations.get(request),
          status: response?.status(),
          url: request.url(),
        });
      });

      await page.goto(`http://127.0.0.1:${address.port}/editor`, {
        waitUntil: "domcontentloaded",
      });
      const editor_startup = await wait_for_adventure(page, browser_errors);
      if (editor_startup.type === "gpu_unavailable") {
        throw new Error(
          `adventure gate-room proof requires a non-fallback WebGPU adapter during editor startup: ${editor_startup.reason}`,
        );
      }
      await prove_editor_controls(page);

      await page.goto(`http://127.0.0.1:${address.port}/game`, {
        waitUntil: "domcontentloaded",
      });
      const startup = await wait_for_adventure(page, browser_errors);
      if (startup.type === "gpu_unavailable") {
        throw new Error(
          `adventure gate-room proof requires a non-fallback WebGPU adapter during game startup: ${startup.reason}`,
        );
      }
      await assert_renderer_ready(page, "raster");
      await assert_prepared_asset_requests(
        page,
        requests,
        application_generation,
      );
      assert.equal(
        await page.getByRole("button", {
          name: "Enter the exit room",
          exact: true,
        }).count(),
        0,
      );

      const raster_gate = await take_key(page);
      assert.equal(
        raster_gate.gate_visible,
        "true",
        JSON.stringify(raster_gate),
      );
      assert.notEqual(
        raster_gate.center_pick,
        "miss",
        JSON.stringify(raster_gate),
      );
      assert.equal(
        raster_gate.gate_pick,
        "adventure-object-106",
        JSON.stringify(raster_gate),
      );
      assert.equal(raster_gate.gate_animation_time, "0");
      assert.equal(raster_gate.gate_rendered_visible, "true");
      assert.equal(Number(raster_gate.gate_render_rotation_y), 0);
      await page.locator("main").focus();
      await page.keyboard.press("Backquote");
      const debugger_window = page.locator('[aria-label="Game debugger"]');
      await debugger_window.waitFor({ state: "visible" });
      assert.match(
        await debugger_window.textContent(),
        /\[adventure-audio\] audio\.commands\.applied/,
      );
      await page.keyboard.press("Backquote");
      await debugger_window.waitFor({ state: "hidden" });
      await unlock_gate(page);
      const raster_exit = await enter_exit_room(page);
      await pause_game(page);

      await reset_game(page);
      await page.getByRole("button", { name: "Path traced", exact: true })
        .click();
      await wait_for_frame_technique(page, "path_traced");
      await play_game(page);
      const path_gate_before_accumulation = await take_key(page);
      await pause_game(page);
      assert.deepEqual(
        comparable_runtime(path_gate_before_accumulation),
        comparable_runtime(raster_gate),
      );

      await accumulate_exact_samples(page, 64);
      const path_gate_after_accumulation = await runtime_evidence(page);
      assert.deepEqual(
        comparable_runtime(path_gate_after_accumulation),
        comparable_runtime(path_gate_before_accumulation),
      );
      assert.equal(
        path_gate_after_accumulation.center_pick,
        raster_gate.center_pick,
        JSON.stringify({ raster_gate, path_gate_after_accumulation }),
      );
      assert.equal(
        await page.locator("main").getAttribute("data-cpu-oracle-pick"),
        path_gate_after_accumulation.center_pick,
        JSON.stringify({ raster_gate, path_gate_after_accumulation }),
      );
      assert.equal(
        path_gate_after_accumulation.gate_pick,
        raster_gate.gate_pick,
        JSON.stringify({ raster_gate, path_gate_after_accumulation }),
      );
      await assert_renderer_ready(page, "path_traced");
      await mkdir(artifact_directory, { recursive: true });
      const screenshot = await capture_gate_room(
        page,
        "gate-room-path-traced.png",
      );
      const coverage = await rendered_coverage(page, screenshot);
      assert.ok(
        coverage.non_clear_fraction > 0.2,
        `adventure gate-room non-clear coverage ${coverage.non_clear_fraction} must exceed 0.2: ${
          JSON.stringify(coverage)
        }`,
      );

      await prove_camera_raster_preview(page, browser_errors);
      await hold_animation(page);
      await reset_game(page);
      await page.getByRole("button", { name: "Path traced", exact: true })
        .click();
      await wait_for_frame_technique(page, "path_traced");
      await play_game(page);
      await take_key(page);
      await unlock_gate(page);
      await pause_game(page);
      await accumulate_exact_samples(page, 64);
      const open_gate_screenshot = await capture_gate_room(
        page,
        "gate-room-open-path-traced.png",
        ".game-action-controls, .transport-controls",
      );
      const open_gate_coverage = await rendered_coverage(
        page,
        open_gate_screenshot,
      );
      assert.ok(
        open_gate_coverage.non_clear_fraction > 0.2,
        `adventure open gate-room non-clear coverage ${open_gate_coverage.non_clear_fraction} must exceed 0.2: ${
          JSON.stringify(open_gate_coverage)
        }`,
      );
      const gate_animation_regions = await compare_gate_animation_regions(
        page,
        screenshot,
        open_gate_screenshot,
      );
      assert.ok(
        gate_animation_regions.aperture_difference > 10,
        `adventure gate aperture difference ${gate_animation_regions.aperture_difference} must exceed 10: ${
          JSON.stringify(gate_animation_regions)
        }`,
      );
      assert.ok(
        gate_animation_regions.stable_wall_difference < 2,
        `adventure stable wall difference ${gate_animation_regions.stable_wall_difference} must stay below 2: ${
          JSON.stringify(gate_animation_regions)
        }`,
      );
      assert.ok(
        gate_animation_regions.aperture_difference >
          gate_animation_regions.stable_wall_difference * 8,
        `adventure gate aperture must change independently of the stable wall: ${
          JSON.stringify(gate_animation_regions)
        }`,
      );
      assert.ok(
        gate_animation_regions.exit_marker_green_minus_red > 10 &&
          gate_animation_regions.exit_marker_blue_minus_red > 5,
        `adventure open gate must reveal the cyan exit marker: ${
          JSON.stringify(gate_animation_regions)
        }`,
      );
      await play_game(page);
      const path_exit = await enter_exit_room(page);
      await pause_game(page);
      assert.deepEqual(
        comparable_runtime(path_exit),
        comparable_runtime(raster_exit),
      );

      const path_exit_pick = path_exit.center_pick;
      await page.getByRole("button", { name: "Raster", exact: true }).click();
      await wait_for_frame_technique(page, "raster");
      const raster_exit_pick = (await runtime_evidence(page)).center_pick;
      assert.equal(raster_exit_pick, path_exit_pick);
      await page.getByRole("button", { name: "Path traced", exact: true })
        .click();
      await wait_for_frame_technique(page, "path_traced");
      assert.equal(
        (await runtime_evidence(page)).center_pick,
        path_exit_pick,
      );
      assert.equal(
        await page.locator("main").getAttribute("data-renderer-generation"),
        "1",
      );
      assert.equal(
        requests.filter(({ generation, url }) =>
          generation === application_generation &&
          new URL(url).pathname.startsWith("/assets/.ink/")
        ).length,
        8,
      );
      assert.deepEqual(browser_errors, []);
      write_scenario_report();
    } finally {
      await browser?.close();
      await server?.close();
    }
  },
);

async function wait_for_prepared_manifest(url) {
  const deadline = performance.now() + 10_000;
  let failure = "no response";
  while (performance.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      const source = await response.text();
      if (!response.ok) {
        failure = `status ${response.status}`;
      } else {
        const manifest = JSON.parse(source);
        if (manifest.version === 1 && manifest.assets?.length === 8) return;
        failure = `unexpected manifest ${source.slice(0, 160)}`;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `adventure prepared manifest ${
      JSON.stringify(url)
    } was not ready: ${failure}`,
  );
}

async function prove_editor_controls(page) {
  const toolbar = page.getByRole("toolbar", { name: "Plan view controls" });
  const status = page.getByRole("status", { name: "Authoring status" });
  await toolbar.waitFor({ state: "visible" });
  await status.waitFor({ state: "visible" });
  const zoom = page.getByRole("status", { name: "Plan zoom" });
  assert.equal(await zoom.textContent(), "100%");
  const zoom_in = page.getByRole("button", { name: "Zoom in" });
  await zoom_in.focus();
  await page.keyboard.press("Enter");
  assert.equal(await zoom.textContent(), "110%");
  const styles = await toolbar.evaluate((element) => {
    const toolbar_style = getComputedStyle(element);
    const zoom_button = element.querySelector('[aria-label="Zoom in"]');
    if (!(zoom_button instanceof HTMLButtonElement)) {
      throw new Error("adventure editor toolbar omitted its zoom control");
    }
    const button_style = getComputedStyle(zoom_button);
    return {
      button_width: Number.parseFloat(button_style.width),
      display: toolbar_style.display,
      minimum_height: Number.parseFloat(toolbar_style.minHeight),
    };
  });
  assert.equal(styles.display, "flex");
  assert.ok(styles.button_width >= 24);
  assert.ok(styles.minimum_height >= 24);
}

async function install_frame_control(page) {
  await page.addInitScript(() => {
    const native_request = globalThis.requestAnimationFrame.bind(globalThis);
    const native_cancel = globalThis.cancelAnimationFrame.bind(globalThis);
    const pending = new Map();
    let held = true;
    let next_identifier = 1;

    const schedule = (identifier, entry) => {
      entry.native_identifier = native_request((now) => {
        pending.delete(identifier);
        entry.callback(now);
      });
    };
    globalThis.requestAnimationFrame = (callback) => {
      const identifier = next_identifier;
      next_identifier += 1;
      const entry = { callback, native_identifier: undefined };
      pending.set(identifier, entry);
      if (!held) schedule(identifier, entry);
      return identifier;
    };
    globalThis.cancelAnimationFrame = (identifier) => {
      const entry = pending.get(identifier);
      if (entry?.native_identifier !== undefined) {
        native_cancel(entry.native_identifier);
      }
      pending.delete(identifier);
    };
    globalThis.__ink_adventure_frames = {
      hold() {
        held = true;
        for (const entry of pending.values()) {
          if (entry.native_identifier === undefined) continue;
          native_cancel(entry.native_identifier);
          entry.native_identifier = undefined;
        }
      },
      release() {
        held = false;
        for (const [identifier, entry] of pending) {
          if (entry.native_identifier === undefined) {
            schedule(identifier, entry);
          }
        }
      },
      step(elapsed_ms) {
        if (!held) {
          throw new Error(
            "adventure frame control must be held before stepping",
          );
        }
        const scheduled = [...pending.entries()];
        if (scheduled.length === 0) {
          throw new Error("adventure frame control has no pending frame");
        }
        for (const [identifier, entry] of scheduled) {
          pending.delete(identifier);
          entry.callback(performance.now() + elapsed_ms);
        }
      },
    };
  });
}

async function wait_for_adventure(page, browser_errors) {
  try {
    await page.waitForFunction(
      () => {
        const state = document.querySelector("main")?.dataset.runtimeState;
        return state === "ready" || state === "failed";
      },
      undefined,
      { polling: 50, timeout: 15_000 },
    );
  } catch (cause) {
    const diagnostics = await page.evaluate(() => ({
      body: document.body.textContent,
      main: document.querySelector("main")?.dataset,
      notice: document.querySelector(".runtime-notice")?.textContent,
      root: document.querySelector("#root")?.innerHTML,
      url: location.href,
    }));
    diagnostics.browser_errors = browser_errors;
    throw new Error(
      `adventure browser did not publish startup state: ${
        JSON.stringify(diagnostics)
      }`,
      { cause },
    );
  }
  const root = page.locator("main[data-runtime-state]");
  const state = await root.getAttribute("data-runtime-state");
  if (
    state === "ready" &&
    await root.getAttribute("data-renderer-generation") === "1"
  ) return { type: "ready" };
  const reason = (await page.locator(".runtime-notice").textContent()) ??
    "adventure renderer failed without evidence";
  if (
    /WebGPU is unavailable|no WebGPU adapter|software fallback|adapter is a software fallback/i
      .test(reason)
  ) {
    return { type: "gpu_unavailable", reason };
  }
  throw new Error(
    `adventure browser runtime failed: ${
      JSON.stringify({
        reason,
        renderer_generation: await root.getAttribute(
          "data-renderer-generation",
        ),
        renderer_status: await root.getAttribute("data-renderer-status"),
        state,
      })
    }`,
  );
}

async function assert_renderer_ready(page, frame_technique) {
  const root = page.locator("main");
  const evidence = {
    adapter: await root.getAttribute("data-adapter"),
    frame_technique: await root.getAttribute("data-frame-technique"),
    renderer_generation: await root.getAttribute("data-renderer-generation"),
    renderer_status: await root.getAttribute("data-renderer-status"),
    validation_errors: await root.getAttribute("data-validation-errors"),
  };
  assert.equal(evidence.renderer_status, "ready", JSON.stringify(evidence));
  assert.equal(evidence.validation_errors, "0", JSON.stringify(evidence));
  assert.equal(evidence.renderer_generation, "1", JSON.stringify(evidence));
  assert.equal(
    evidence.frame_technique,
    frame_technique,
    JSON.stringify(evidence),
  );
  assert.doesNotMatch(
    evidence.adapter ?? "",
    /fallback|swiftshader|software/i,
    JSON.stringify(evidence),
  );
}

async function assert_prepared_asset_requests(
  page,
  requests,
  application_generation,
) {
  const manifest = await page.evaluate(async () => {
    const response = await fetch("/assets.manifest.json", {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`asset manifest returned ${response.status}`);
    }
    return await response.json();
  });
  const expected_locations = manifest.assets.map(({ location }) =>
    new URL(location, page.url()).href
  ).sort();
  const digest_requests = requests.filter(({ generation, url }) =>
    generation === application_generation &&
    new URL(url).pathname.startsWith("/assets/.ink/")
  );
  assert.deepEqual(
    digest_requests.map(({ url }) => url).sort(),
    expected_locations,
    JSON.stringify({ digest_requests, expected_locations }),
  );
  assert.ok(
    digest_requests.every(({ status }) => status === 200),
    JSON.stringify(digest_requests),
  );
  const raw_asset_requests = requests.filter(({ url }) =>
    /\.(?:obj|png)$/i.test(new URL(url).pathname)
  );
  assert.deepEqual(raw_asset_requests, []);
}

async function take_key(page) {
  await page.getByRole("button", { name: "Take brass key", exact: true })
    .click();
  await wait_for_status(page, "Unlock oak gate");
  const evidence = await runtime_evidence(page);
  const spatial = JSON.parse(evidence.spatial_audio);
  assert.equal(spatial.cue, "adventure.key", JSON.stringify(spatial));
  assert.ok(spatial.gain > 0 && spatial.gain < 1, JSON.stringify(spatial));
  assert.ok(Math.abs(spatial.pan) > 0.8, JSON.stringify(spatial));
  assert.equal(spatial.doppler_pitch, 1, JSON.stringify(spatial));
  assert.equal(
    await page.getByRole("button", {
      name: "Enter the exit room",
      exact: true,
    }).count(),
    0,
  );
  return evidence;
}

async function unlock_gate(page) {
  await page.getByRole("button", { name: "Unlock oak gate", exact: true })
    .click();
  await wait_for_status(page, "Enter the exit room");
  const evidence = await runtime_evidence(page);
  assert.equal(evidence.gate_visible, "false", JSON.stringify(evidence));
  assert.equal(evidence.gate_animation_time, "1", JSON.stringify(evidence));
  assert.equal(
    evidence.gate_rendered_visible,
    "true",
    JSON.stringify(evidence),
  );
  assert.ok(
    Math.abs(Number(evidence.gate_render_rotation_y) + Math.PI * 0.44) < 1e-9,
    JSON.stringify(evidence),
  );
  assert.deepEqual(
    JSON.parse(evidence.gate_render_position),
    [-1.6, 0, 3.1],
    JSON.stringify(evidence),
  );
  const spatial = JSON.parse(evidence.spatial_audio);
  assert.equal(spatial.cue, "adventure.gate", JSON.stringify(spatial));
  assert.ok(spatial.gain > 0 && spatial.gain < 1, JSON.stringify(spatial));
  assert.notEqual(spatial.doppler_pitch, 1, JSON.stringify(spatial));
  assert.equal(
    await page.getByRole("button", {
      name: "Enter the exit room",
      exact: true,
    }).count(),
    1,
  );
  return evidence;
}

async function enter_exit_room(page) {
  await page.getByRole("button", { name: "Enter the exit room", exact: true })
    .click();
  await wait_for_status(page, "Exit room reached");
  const evidence = await runtime_evidence(page);
  assert.equal(evidence.sequence, "3", JSON.stringify(evidence));
  assert.deepEqual(
    JSON.parse(evidence.player_position),
    [0, 500_000, 4_750_000],
    JSON.stringify(evidence),
  );
  const spatial = JSON.parse(evidence.spatial_audio);
  assert.equal(spatial.cue, "adventure.exit", JSON.stringify(spatial));
  assert.equal(spatial.gain, 1, JSON.stringify(spatial));
  assert.equal(spatial.pan, 0, JSON.stringify(spatial));
  assert.equal(spatial.doppler_pitch, 1, JSON.stringify(spatial));
  return evidence;
}

async function play_game(page) {
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true })
    .waitFor({ state: "visible" });
  await page.waitForFunction(
    () => {
      const button = document.querySelector(
        '.transport-controls button[aria-label="Pause"]',
      );
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    undefined,
    { polling: 50 },
  );
}

async function pause_game(page) {
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.waitForFunction(
    () => {
      const button = document.querySelector(
        '.transport-controls button[aria-label="Pause"]',
      );
      return button instanceof HTMLButtonElement && button.disabled;
    },
    undefined,
    { polling: 50 },
  );
  await page.waitForTimeout(0);
}

async function reset_game(page) {
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.waitForFunction(
    () => {
      const main = document.querySelector("main");
      if (main?.dataset.runtimeSequence !== "0") return false;
      const source = main.dataset.semanticObservation;
      if (source === undefined) return false;
      return JSON.parse(source).status.value === "Take brass key";
    },
    undefined,
    { polling: 50 },
  );
}

async function wait_for_status(page, status) {
  await page.waitForFunction(
    (expected) => {
      const source = document.querySelector("main")?.dataset
        .semanticObservation;
      if (source === undefined) return false;
      return JSON.parse(source).status.value === expected;
    },
    status,
    { polling: 50 },
  );
}

async function runtime_evidence(page) {
  const root = page.locator("main");
  const evidence = {
    center_pick: await root.getAttribute("data-center-pick"),
    checksum: await root.getAttribute("data-snapshot-checksum"),
    gate_animation_time: await root.getAttribute("data-gate-animation-time"),
    gate_render_position: await root.getAttribute("data-gate-render-position"),
    gate_render_rotation_y: await root.getAttribute(
      "data-gate-render-rotation-y",
    ),
    gate_rendered_visible: await root.getAttribute(
      "data-gate-rendered-visible",
    ),
    gate_visible: await root.getAttribute("data-gate-visible"),
    gate_pick: await root.getAttribute("data-gate-pick"),
    key_visible: await root.getAttribute("data-key-visible"),
    player_position: await root.getAttribute("data-player-position"),
    semantic: await root.getAttribute("data-semantic-observation"),
    sequence: await root.getAttribute("data-runtime-sequence"),
    spatial_audio: await root.getAttribute("data-spatial-audio"),
  };
  for (const [field, value] of Object.entries(evidence)) {
    if (value === null || value.length === 0) {
      throw new Error(
        `adventure browser omitted runtime evidence ${field}: ${
          JSON.stringify(evidence)
        }`,
      );
    }
  }
  return evidence;
}

function comparable_runtime(evidence) {
  return {
    checksum: evidence.checksum,
    gate_animation_time: evidence.gate_animation_time,
    gate_render_position: evidence.gate_render_position,
    gate_render_rotation_y: evidence.gate_render_rotation_y,
    gate_rendered_visible: evidence.gate_rendered_visible,
    gate_visible: evidence.gate_visible,
    key_visible: evidence.key_visible,
    player_position: evidence.player_position,
    semantic: evidence.semantic,
    sequence: evidence.sequence,
    spatial_audio: evidence.spatial_audio,
  };
}

async function wait_for_frame_technique(page, technique) {
  await page.waitForFunction(
    (expected) =>
      document.querySelector("main")?.dataset.frameTechnique === expected,
    technique,
    { polling: 50 },
  );
}

async function accumulate_exact_samples(page, target_samples) {
  await hold_animation(page);
  let accumulated = Number(
    await page.locator("main").getAttribute("data-accumulated-samples"),
  );
  while (accumulated < target_samples) {
    const before = accumulated;
    await page.evaluate(() => globalThis.__ink_adventure_frames.step(16));
    await page.waitForFunction(
      (previous) =>
        Number(document.querySelector("main")?.dataset.accumulatedSamples) >
          previous,
      before,
      { polling: 10, timeout: 10_000 },
    );
    accumulated = Number(
      await page.locator("main").getAttribute("data-accumulated-samples"),
    );
  }
  assert.equal(
    accumulated,
    target_samples,
    `adventure path tracing crossed the requested ${target_samples}-sample capture threshold`,
  );
  const evidence = await page.locator("main").evaluate((root) => ({
    accumulated_samples: root.dataset.accumulatedSamples,
    frame_technique: root.dataset.frameTechnique,
    renderer_status: root.dataset.rendererStatus,
    selected_technique: root.dataset.renderTechnique,
    visible_progress: root.querySelector(
      '[aria-label="Rendering progress"]',
    )?.textContent,
  }));
  assert.deepEqual(evidence, {
    accumulated_samples: String(target_samples),
    frame_technique: "path_traced",
    renderer_status: "ready",
    selected_technique: "path_traced",
    visible_progress: `Path traced · ${target_samples} samples`,
  });
}

async function hold_animation(page) {
  await page.evaluate(() => globalThis.__ink_adventure_frames.hold());
}

async function prove_camera_raster_preview(page, browser_errors) {
  await page.goto(new URL("/debug", page.url()).href, {
    waitUntil: "domcontentloaded",
  });
  const startup = await wait_for_adventure(page, browser_errors);
  assert.deepEqual(startup, { type: "ready" });
  await page.evaluate(() => globalThis.__ink_adventure_frames.step(16));
  await page.waitForFunction(
    () => {
      const root = document.querySelector("main");
      return root?.dataset.snapshotChecksum !== undefined &&
        root.dataset.runtimeSequence !== undefined;
    },
    undefined,
    { polling: 10, timeout: 5_000 },
  );
  const pause_button = page.getByRole("button", {
    name: "Pause",
    exact: true,
  });
  await pause_button.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => {
      const button = document.querySelector(
        '.transport-controls button[aria-label="Pause"]',
      );
      return button instanceof HTMLButtonElement && button.disabled;
    },
    undefined,
    { polling: 50 },
  );
  const path_traced_button = page.getByRole("button", {
    name: "Path traced",
    exact: true,
  });
  await path_traced_button.focus();
  await page.keyboard.press("Enter");
  await wait_for_frame_technique(page, "path_traced");
  await accumulate_exact_samples(page, 8);

  const debug_root = page.locator("main");
  const read_debug_runtime = () =>
    debug_root.evaluate((root) => ({
      blot_camera: root.dataset.blotCamera,
      blot_environment: root.dataset.blotEnvironment,
      checksum: root.dataset.snapshotChecksum,
      gate_visible: root.dataset.gateVisible,
      key_visible: root.dataset.keyVisible,
      player_position: root.dataset.playerPosition,
      semantic: root.dataset.semanticObservation,
      sequence: root.dataset.runtimeSequence,
    }));
  const before = await read_debug_runtime();
  assert.ok(
    Object.values(before).every((field) => field !== undefined),
    JSON.stringify(before),
  );
  const host_camera_before = await debug_root.getAttribute(
    "data-host-camera",
  );
  await page.getByRole("region", { name: "Debug camera" }).dispatchEvent(
    "wheel",
    {
      deltaY: -120,
    },
  );
  try {
    await page.waitForFunction(
      () => {
        const root = document.querySelector("main");
        return root?.dataset.frameTechnique === "raster" &&
          root.dataset.frameReason === "camera_motion";
      },
      undefined,
      { polling: 50, timeout: 5_000 },
    );
  } catch (cause) {
    const root = page.locator("main");
    throw new Error(
      `adventure camera did not switch path tracing to raster preview: ${
        JSON.stringify({
          before,
          frame_reason: await root.getAttribute("data-frame-reason"),
          frame_technique: await root.getAttribute("data-frame-technique"),
          runtime: await read_debug_runtime(),
        })
      }`,
      { cause },
    );
  }
  assert.deepEqual(await read_debug_runtime(), before);
  assert.notEqual(
    await debug_root.getAttribute("data-host-camera"),
    host_camera_before,
  );
  await page.getByRole("button", { name: "Reset debug camera" }).click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector("main")?.getAttribute("data-host-camera") ===
        expected,
    host_camera_before,
    { polling: 10, timeout: 5_000 },
  );
  await accumulate_exact_samples(page, 4);
  await page.goto(new URL("/game", page.url()).href, {
    waitUntil: "domcontentloaded",
  });
  assert.deepEqual(
    await wait_for_adventure(page, browser_errors),
    { type: "ready" },
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
      throw new Error("adventure screenshot proof has no 2D context");
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

async function compare_gate_animation_regions(page, closed, open) {
  return await page.evaluate(async ({ closed_png, open_png }) => {
    const decode = async (encoded_png) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded_png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) {
        throw new Error("adventure gate comparison has no 2D context");
      }
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height);
    };
    const [closed_image, open_image] = await Promise.all([
      decode(closed_png),
      decode(open_png),
    ]);
    if (
      closed_image.width !== open_image.width ||
      closed_image.height !== open_image.height
    ) {
      throw new Error(
        `adventure gate screenshots differ in size: closed ${closed_image.width}x${closed_image.height}, open ${open_image.width}x${open_image.height}`,
      );
    }
    const region = (left, top, right, bottom) => {
      const minimum_x = Math.floor(closed_image.width * left);
      const maximum_x = Math.ceil(closed_image.width * right);
      const minimum_y = Math.floor(closed_image.height * top);
      const maximum_y = Math.ceil(closed_image.height * bottom);
      let difference = 0;
      let open_red = 0;
      let open_green = 0;
      let open_blue = 0;
      let pixels = 0;
      for (let y = minimum_y; y < maximum_y; y += 1) {
        for (let x = minimum_x; x < maximum_x; x += 1) {
          const offset = (y * closed_image.width + x) * 4;
          for (let channel = 0; channel < 3; channel += 1) {
            difference += Math.abs(
              closed_image.data[offset + channel] -
                open_image.data[offset + channel],
            );
          }
          open_red += open_image.data[offset];
          open_green += open_image.data[offset + 1];
          open_blue += open_image.data[offset + 2];
          pixels += 1;
        }
      }
      return {
        difference: difference / (pixels * 3),
        open_blue: open_blue / pixels,
        open_green: open_green / pixels,
        open_red: open_red / pixels,
      };
    };
    const aperture = region(0.5, 0.24, 0.605, 0.53);
    const stable_wall = region(0.68, 0.24, 0.89, 0.48);
    const exit_marker = region(0.568, 0.426, 0.575, 0.493);
    return {
      aperture_difference: aperture.difference,
      exit_marker_blue_minus_red: exit_marker.open_blue -
        exit_marker.open_red,
      exit_marker_green_minus_red: exit_marker.open_green -
        exit_marker.open_red,
      stable_wall_difference: stable_wall.difference,
    };
  }, {
    closed_png: closed.toString("base64"),
    open_png: open.toString("base64"),
  });
}

async function capture_gate_room(
  page,
  filename,
  hidden_overlays =
    ".game-action-controls, .render-technique-controls, .transport-controls",
) {
  const hiding_style = await page.addStyleTag({
    content: `${hidden_overlays} { visibility: hidden !important; }`,
  });
  try {
    return await page.locator("ink-adventure-surface canvas").screenshot({
      path: `${artifact_directory}/${filename}`,
      timeout: 90_000,
      type: "png",
    });
  } finally {
    await hiding_style.evaluate((element) => element.remove());
  }
}

function write_scenario_report() {
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
      "--passed",
      "browser:gate-room-raster-path-parity",
      "--passed",
      "browser:prepared-assets-eight-verified-digests",
      "--passed",
      "browser:editor-controls-keyboard-and-layout",
      "--passed",
      "browser:oak-gate-animation-changes-rendered-transform",
      "--passed",
      "browser:canonical-route-opens-after-gate",
      "--passed",
      "browser:edited-oak-gate-blocks-and-opens-route",
      "--passed",
      "browser:spatial-audio-submits-authored-cues",
    ],
    {
      cwd: application_directory,
      encoding: "utf8",
      env: process.env,
    },
  );
  if (report.error !== undefined) {
    throw new Error("adventure browser report could not start", {
      cause: report.error,
    });
  }
  if (report.status !== 0) {
    const evidence = report.stderr.trim() || report.stdout.trim() ||
      `signal ${report.signal}`;
    throw new Error(
      `adventure browser report exited with ${report.status}: ${evidence}`,
    );
  }
}
