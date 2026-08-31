import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import path_tracing_regions from "./path_tracing_regions.json" with {
  type: "json",
};

const artifact_directory = fileURLToPath(
  new URL("../../../../artifacts/lighting/", import.meta.url),
);
const viewport = { width: 960, height: 720 };

const cornell_regions = path_tracing_regions.cornell;
const fog_regions = path_tracing_regions.fog;

test(
  "portable WebGPU path tracing proves Cornell and Fog pixels",
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
          `lighting browser server returned invalid address ${
            JSON.stringify(address)
          }`,
        );
      }

      browser = await chromium.launch({
        headless: true,
        args: [
          "--enable-unsafe-webgpu",
          "--enable-features=Vulkan",
          "--use-angle=vulkan",
        ],
      });
      const page = await browser.newPage({ viewport });
      await install_animation_capture_control(page);
      const browser_errors = [];
      page.on("crash", () => browser_errors.push("page crashed"));
      page.on("pageerror", (error) => browser_errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") browser_errors.push(message.text());
      });
      const origin = `http://127.0.0.1:${address.port}`;

      await open_lighting_comparison(
        page,
        `${origin}?scene=cornell&comparison=single-bounce`,
        "single_bounce",
      );
      await select_path_tracing(page, 8);
      await accumulate_exact_samples(page, 64);
      const cornell_single_bounce = await read_canvas_regions(
        page,
        cornell_regions,
      );
      await assert_renderer_evidence(page, "cornell.mirror");

      await open_lighting_comparison(
        page,
        `${origin}?scene=cornell`,
        "reference",
      );
      await assert_settings_contract(page);
      await select_path_tracing(page, 8);
      await prove_camera_preview(page);
      await accumulate_exact_samples(page, 64);
      await wait_for_pick_samples(page, 1);
      await assert_renderer_evidence(page, "cornell.mirror");
      await mkdir(artifact_directory, { recursive: true });
      const cornell = await read_canvas_regions(page, cornell_regions, {
        path: `${artifact_directory}/cornell-path-traced.png`,
      });
      assert_non_clear_coverage(cornell, "Cornell");
      assert_cornell_regions(cornell, cornell_single_bounce);

      await page.getByRole("button", { name: "Fog", exact: true }).click();
      await wait_for_reference(page, "fog-room");
      await step_animation(page);
      await page.waitForFunction(() => {
        const root = document.querySelector("main");
        return root?.dataset.frameTechnique === "raster" &&
          root.dataset.frameReason === "camera_motion";
      });
      await step_animation(page);
      await wait_for_reference_accumulation_reset(page, "fog-room", 8);
      await accumulate_exact_samples(page, 64);
      await wait_for_pick_samples(page, 1);
      const fog_first = await read_canvas_regions(page, fog_regions);
      await accumulate_additional_samples(page, 32);
      const fog_second = await read_canvas_regions(page, fog_regions, {
        path: `${artifact_directory}/fog-path-traced.png`,
      });
      await assert_renderer_evidence(page, "glazed-ceramic");
      assert_non_clear_coverage(fog_second, "Fog");
      assert_fog_regions(fog_second);
      assert_bounded_temporal_variance(fog_first, fog_second);

      await open_lighting_comparison(
        page,
        `${origin}?scene=fog-room&comparison=flat-normals`,
        "flat_normals",
      );
      await select_path_tracing(page, 8);
      await accumulate_exact_samples(page, 64);
      await wait_for_pick_samples(page, 1);
      const fog_flat_normal_control = await read_canvas_regions(
        page,
        fog_regions,
      );
      await assert_renderer_evidence(page, "glazed-ceramic");
      assert_fog_normal_mapping(fog_first, fog_flat_normal_control);

      await open_lighting_comparison(
        page,
        `${origin}?scene=fog-room&comparison=diffuse-materials`,
        "diffuse_materials",
      );
      await select_path_tracing(page, 8);
      await accumulate_exact_samples(page, 64);
      await wait_for_pick_samples(page, 1);
      const fog_diffuse_control = await read_canvas_regions(page, fog_regions);
      await assert_renderer_evidence(page, "glazed-ceramic");
      assert_fog_material_reflections(fog_first, fog_diffuse_control);

      await assert_raster_only_reference(page, {
        button_name: "Bistro",
        reason: "Bistro remains a raster stress scene.",
        reference: "bistro",
      });
      await page.getByRole("button", { name: "Cornell", exact: true }).click();
      await wait_for_reference(page, "cornell");
      const path_button = page.getByRole("button", {
        name: "Path traced",
        exact: true,
      });
      assert.equal(await path_button.isDisabled(), false);
      await path_button.click();
      await page.waitForFunction(() =>
        document.querySelector(
          '.technique-picker button[value="path_traced"]',
        )?.getAttribute("aria-pressed") === "true"
      );
      await assert_raster_only_reference(page, {
        button_name: "Hotel",
        reason: "Caldera path tracing requires digest-keyed acceleration data.",
        reference: "caldera",
      });

      assert.deepEqual(browser_errors, []);
    } finally {
      await browser?.close();
      await server?.close();
    }
  },
);

async function open_lighting_comparison(page, url, expected_comparison) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const startup = await wait_for_lighting(page);
  if (startup.type === "gpu_unavailable") {
    throw new Error(
      `lighting path-tracing proof requires a non-fallback WebGPU adapter: ${startup.reason}`,
    );
  }
  assert.equal(
    await page.locator("main").getAttribute("data-render-comparison"),
    expected_comparison,
  );
  await hold_animation(page);
}

async function install_animation_capture_control(page) {
  await page.addInitScript(() => {
    const native_request = globalThis.requestAnimationFrame.bind(globalThis);
    const native_cancel = globalThis.cancelAnimationFrame.bind(globalThis);
    const pending = new Map();
    let held = false;
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
    globalThis.__ink_lighting_frames = {
      hold() {
        held = true;
        for (const entry of pending.values()) {
          if (entry.native_identifier === undefined) continue;
          native_cancel(entry.native_identifier);
          entry.native_identifier = undefined;
        }
      },
      step(elapsed_ms) {
        if (!held) {
          throw new Error(
            "lighting frame control must be held before stepping",
          );
        }
        const scheduled = [...pending.entries()];
        if (scheduled.length === 0) {
          throw new Error("lighting frame control has no pending frame");
        }
        for (const [identifier, entry] of scheduled) {
          pending.delete(identifier);
          entry.callback(performance.now() + elapsed_ms);
        }
      },
    };
  });
}

async function hold_animation(page) {
  await page.evaluate(() => globalThis.__ink_lighting_frames.hold());
}

async function step_animation(page) {
  await page.evaluate(() => globalThis.__ink_lighting_frames.step(16));
}

async function wait_for_lighting(page) {
  await page.waitForFunction(() => {
    const state = document.querySelector("main")?.dataset.runtimeState;
    return state === "ready" || state === "failed";
  });
  const root = page.locator("main");
  const state = await root.getAttribute("data-runtime-state");
  if (state === "ready") return { type: "ready" };
  const reason = (await page.locator(".status-line output").textContent()) ??
    "lighting runtime failed without evidence";
  if (
    /WebGPU is unavailable|no WebGPU adapter|software fallback|adapter is a software fallback/i
      .test(reason)
  ) {
    return { type: "gpu_unavailable", reason };
  }
  throw new Error(`lighting browser runtime failed: ${reason}`);
}

async function assert_settings_contract(page) {
  await page.mouse.move(viewport.width - 1, viewport.height - 1);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  try {
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector(".settings-panel")).opacity ===
          "0.6",
      undefined,
      { polling: 25, timeout: 3_000 },
    );
  } catch (error) {
    const state = await page.locator(".settings-panel").evaluate((panel) => ({
      active_element: document.activeElement?.outerHTML,
      dragging: panel.hasAttribute("data-dragging"),
      focused: panel.matches(":focus-within"),
      hovered: panel.matches(":hover"),
      opacity: getComputedStyle(panel).opacity,
      panel_bounds: panel.getBoundingClientRect().toJSON(),
    }));
    throw new Error(
      `inactive lighting settings did not settle: ${JSON.stringify(state)}`,
      { cause: error },
    );
  }
  const evidence = await page.locator(".settings-panel").evaluate((panel) => {
    const text = [
      ...panel.querySelectorAll(
        "h1, button, .setting-slider, .status-line",
      ),
    ];
    const slider_controls = [...panel.querySelectorAll(
      ".setting-slider-control",
    )];
    return {
      inactive_opacity: getComputedStyle(panel).opacity,
      minimum_font_size: Math.min(
        ...text.map((element) =>
          Number.parseFloat(getComputedStyle(element).fontSize)
        ),
      ),
      slider_control_heights: slider_controls.map((element) =>
        element.getBoundingClientRect().height
      ),
      slider_labels: [...panel.querySelectorAll(".setting-slider")].map(
        (element) =>
          element.querySelector(".setting-slider-heading span")
            ?.textContent,
      ),
      slider_thumb_sizes: [...panel.querySelectorAll(
        ".setting-slider-thumb",
      )].map((element) => {
        const bounds = element.getBoundingClientRect();
        return { height: bounds.height, width: bounds.width };
      }),
      ticks_per_slider: slider_controls.map((element) =>
        element.querySelectorAll(".setting-slider-ticks span").length
      ),
      technique_labels: [...panel.querySelectorAll(
        ".technique-picker button",
      )].map((element) => element.textContent),
    };
  });
  assert.equal(evidence.inactive_opacity, "0.6", JSON.stringify(evidence));
  assert.ok(evidence.minimum_font_size >= 16, JSON.stringify(evidence));
  assert.deepEqual(
    evidence.technique_labels,
    ["Raster", "Path traced"],
    JSON.stringify(evidence),
  );
  assert.deepEqual(
    evidence.slider_labels,
    ["Samples / frame", "Sun", "Ambient", "Exposure", "Fog", "Move speed"],
    JSON.stringify(evidence),
  );
  assert.ok(
    evidence.slider_control_heights.every((height) => height >= 44),
    JSON.stringify(evidence),
  );
  assert.ok(
    evidence.slider_thumb_sizes.every(({ height, width }) =>
      height >= 44 && width >= 44
    ),
    JSON.stringify(evidence),
  );
  assert.ok(
    evidence.ticks_per_slider.every((count) => count === 5),
    JSON.stringify(evidence),
  );
}

async function assert_raster_only_reference(
  page,
  { button_name, reason, reference },
) {
  await page.getByRole("button", { name: button_name, exact: true }).click();
  await page.waitForFunction(
    (expected) => {
      const root = document.querySelector("main");
      return root?.dataset.reference === expected &&
        root.dataset.techniqueSupport === "raster_only";
    },
    reference,
    { polling: 25 },
  );
  const path_button = page.getByRole("button", {
    name: "Path traced",
    exact: true,
  });
  const evidence = {
    path_description: await path_button.getAttribute("aria-describedby"),
    path_disabled: await path_button.isDisabled(),
    path_title: await path_button.getAttribute("title"),
    raster_selected: await page.getByRole("button", {
      name: "Raster",
      exact: true,
    }).getAttribute("aria-pressed"),
    reason: await page.locator(".technique-availability").textContent(),
  };
  assert.deepEqual(evidence, {
    path_description: "path-tracing-availability",
    path_disabled: true,
    path_title: reason,
    raster_selected: "true",
    reason,
  });
}

async function select_path_tracing(page, samples_per_frame) {
  await page.getByRole("button", { name: "Path traced", exact: true }).click();
  await page.getByRole("slider", { name: "Samples / frame" }).fill(
    String(samples_per_frame),
  );
  await step_animation(page);
  await page.waitForFunction(() =>
    document.querySelector("main")?.dataset.frameTechnique === "path_traced"
  );
}

async function prove_camera_preview(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.keyboard.down("w");
  try {
    await step_animation(page);
    await page.waitForFunction(() => {
      const root = document.querySelector("main");
      return root?.dataset.frameTechnique === "raster" &&
        root.dataset.frameReason === "camera_motion";
    });
  } finally {
    await page.keyboard.up("w");
  }
  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  await step_animation(page);
  await page.waitForFunction(() => {
    const root = document.querySelector("main");
    return root?.dataset.frameTechnique === "raster" &&
      root.dataset.frameReason === "camera_motion";
  });
  await step_animation(page);
  await page.waitForFunction(() =>
    document.querySelector("main")?.dataset.frameTechnique === "path_traced"
  );
}

async function wait_for_reference(page, reference) {
  try {
    await page.waitForFunction(
      (expected) => {
        const root = document.querySelector("main");
        return root?.dataset.reference === expected &&
          (root.dataset.runtimeState === "ready" ||
            root.dataset.runtimeState === "failed");
      },
      reference,
      { polling: 25 },
    );
  } catch (error) {
    const evidence = await page.evaluate(() => ({
      active_element: document.activeElement?.outerHTML,
      checked_buttons: [...document.querySelectorAll("button")]
        .filter((button) => button.getAttribute("aria-checked") === "true")
        .map((button) => button.textContent),
      reference: document.querySelector("main")?.dataset.reference,
      runtime_state: document.querySelector("main")?.dataset.runtimeState,
      status: document.querySelector(".status-line output")?.textContent,
    }));
    throw new Error(
      `lighting reference ${JSON.stringify(reference)} did not settle: ${
        JSON.stringify(evidence)
      }`,
      { cause: error },
    );
  }
  const root = page.locator("main");
  const runtime_state = await root.getAttribute("data-runtime-state");
  if (runtime_state === "ready") return;
  const reason = (await page.locator(".status-line output").textContent()) ??
    "lighting reference failed without evidence";
  throw new Error(
    `lighting reference ${JSON.stringify(reference)} failed: ${reason}`,
  );
}

async function accumulate_exact_samples(page, target_samples) {
  let accumulated = Number(
    await page.locator("main").getAttribute("data-accumulated-samples"),
  );
  while (accumulated < target_samples) {
    const previous = accumulated;
    await step_animation(page);
    await page.waitForFunction(
      (before) =>
        Number(document.querySelector("main")?.dataset.accumulatedSamples) >
          before,
      previous,
      { timeout: 60_000 },
    );
    accumulated = Number(
      await page.locator("main").getAttribute("data-accumulated-samples"),
    );
  }
  assert.equal(
    accumulated,
    target_samples,
    `lighting path tracing crossed the requested ${target_samples}-sample capture threshold`,
  );
}

async function accumulate_additional_samples(page, additional_samples) {
  const current = Number(
    await page.locator("main").getAttribute("data-accumulated-samples"),
  );
  await accumulate_exact_samples(page, current + additional_samples);
}

async function wait_for_reference_accumulation_reset(
  page,
  reference,
  maximum_samples,
) {
  await page.waitForFunction(
    ({ expected_reference, maximum }) => {
      const root = document.querySelector("main");
      return root?.dataset.reference === expected_reference &&
        root.dataset.frameTechnique === "path_traced" &&
        Number(root.dataset.accumulatedSamples) <= maximum;
    },
    { expected_reference: reference, maximum: maximum_samples },
    { timeout: 60_000 },
  );
}

async function wait_for_pick_samples(page, minimum_samples) {
  await page.waitForFunction(
    (minimum) =>
      Number(document.querySelector("main")?.dataset.centerPickSamples) >=
        minimum,
    minimum_samples,
  );
}

async function assert_renderer_evidence(page, expected_pick) {
  const root = page.locator("main");
  const evidence = {
    adapter: await root.getAttribute("data-adapter"),
    pick: await root.getAttribute("data-center-pick"),
    renderer_status: await root.getAttribute("data-renderer-status"),
    validation_errors: await root.getAttribute("data-validation-errors"),
  };
  assert.equal(evidence.renderer_status, "ready", JSON.stringify(evidence));
  assert.equal(evidence.validation_errors, "0", JSON.stringify(evidence));
  assert.doesNotMatch(
    evidence.adapter ?? "",
    /fallback|swiftshader|software/i,
    JSON.stringify(evidence),
  );
  assert.notEqual(evidence.pick, "pending", JSON.stringify(evidence));
  assert.notEqual(evidence.pick, "miss", JSON.stringify(evidence));
  if (expected_pick !== undefined) {
    assert.equal(evidence.pick, expected_pick, JSON.stringify(evidence));
  }
}

async function read_canvas_regions(page, regions, screenshot_options = {}) {
  const screenshot = await capture_canvas(page, screenshot_options);
  return await page.evaluate(async ({ encoded_png, requested_regions }) => {
    const rendered = new Image();
    rendered.src = `data:image/png;base64,${encoded_png}`;
    await rendered.decode();
    const copy = document.createElement("canvas");
    copy.width = rendered.naturalWidth;
    copy.height = rendered.naturalHeight;
    const context = copy.getContext("2d", { willReadFrequently: true });
    if (context === null) throw new Error("lighting proof has no 2D context");
    context.drawImage(rendered, 0, 0, copy.width, copy.height);
    const image = context.getImageData(0, 0, copy.width, copy.height);

    const summarize = (bounds) => {
      const minimum_x = Math.floor(bounds.x * image.width);
      const minimum_y = Math.floor(bounds.y * image.height);
      const maximum_x = Math.ceil((bounds.x + bounds.width) * image.width);
      const maximum_y = Math.ceil((bounds.y + bounds.height) * image.height);
      const luminance = [];
      const temporal_samples = [];
      let red = 0;
      let green = 0;
      let blue = 0;
      let blue_dominant = 0;
      let count = 0;
      for (let y = minimum_y; y < maximum_y; y += 1) {
        for (let x = minimum_x; x < maximum_x; x += 1) {
          const offset = (y * image.width + x) * 4;
          const r = image.data[offset];
          const g = image.data[offset + 1];
          const b = image.data[offset + 2];
          const value = r * 0.2126 + g * 0.7152 + b * 0.0722;
          red += r;
          green += g;
          blue += b;
          luminance.push(value);
          if (b > r * 1.25 && b > g * 1.25 && b > 16) blue_dominant += 1;
          if ((x - minimum_x) % 8 === 0 && (y - minimum_y) % 8 === 0) {
            temporal_samples.push(value);
          }
          count += 1;
        }
      }
      luminance.sort((left, right) => left - right);
      const percentile = (fraction) =>
        luminance[
          Math.min(
            luminance.length - 1,
            Math.floor(luminance.length * fraction),
          )
        ];
      const mean = luminance.reduce((sum, value) => sum + value, 0) / count;
      const deviation = Math.sqrt(
        luminance.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
          count,
      );
      return {
        blue_dominant_fraction: blue_dominant / count,
        luminance: {
          deviation,
          mean,
          p10: percentile(0.1),
          p50: percentile(0.5),
          p90: percentile(0.9),
          p99: percentile(0.99),
        },
        mean: { r: red / count, g: green / count, b: blue / count },
        temporal_samples,
      };
    };

    const summaries = {};
    for (const [name, bounds] of Object.entries(requested_regions)) {
      summaries[name] = summarize(bounds);
    }
    const complete = summarize({ x: 0, y: 0, width: 1, height: 1 });
    const non_clear_pixels = complete.temporal_samples.filter((value) =>
      value > 4
    ).length;
    return {
      coverage: non_clear_pixels / complete.temporal_samples.length,
      height: image.height,
      regions: summaries,
      width: image.width,
    };
  }, {
    encoded_png: screenshot.toString("base64"),
    requested_regions: regions,
  });
}

async function capture_canvas(page, options = {}) {
  const panel = page.locator(".settings-panel");
  const previous_visibility = await panel.evaluate((element) => {
    const previous = element.style.visibility;
    element.style.visibility = "hidden";
    return previous;
  });
  try {
    return await page.screenshot({
      ...options,
      fullPage: false,
      timeout: 90_000,
      type: "png",
    });
  } finally {
    await panel.evaluate((element, visibility) => {
      element.style.visibility = visibility;
    }, previous_visibility);
  }
}

function assert_non_clear_coverage(proof, label) {
  assert.equal(
    proof.width > 0 && proof.height > 0,
    true,
    JSON.stringify(proof),
  );
  assert.ok(
    proof.coverage > 0.35,
    `${label} non-clear coverage ${proof.coverage} must exceed 0.35; ${
      JSON.stringify(region_diagnostics(proof))
    }`,
  );
}

function assert_cornell_regions(proof, single_bounce) {
  const { regions } = proof;
  const channel_fraction = (region, channel) => {
    const total = region.mean.r + region.mean.g + region.mean.b;
    return region.mean[channel] / total;
  };
  const red_chroma_gain = ["neutral_red_floor", "neutral_red_back"].reduce(
    (sum, name) =>
      sum + channel_fraction(regions[name], "r") -
      channel_fraction(single_bounce.regions[name], "r"),
    0,
  ) / 2;
  const green_chroma_gain = [
    "neutral_green_floor",
    "neutral_green_back",
  ].reduce(
    (sum, name) =>
      sum + channel_fraction(regions[name], "g") -
      channel_fraction(single_bounce.regions[name], "g"),
    0,
  ) / 2;
  assert.ok(
    red_chroma_gain > 0.01,
    `Cornell multi-bounce light did not add red chroma to neutral white surfaces: ${
      JSON.stringify({
        multi_bounce: region_diagnostics(proof),
        red_chroma_gain,
        single_bounce: region_diagnostics(single_bounce),
      })
    }`,
  );
  assert.ok(
    green_chroma_gain > 0.01,
    `Cornell multi-bounce light did not add green chroma to neutral white surfaces: ${
      JSON.stringify({
        green_chroma_gain,
        multi_bounce: region_diagnostics(proof),
        single_bounce: region_diagnostics(single_bounce),
      })
    }`,
  );
  assert.ok(
    regions.penumbra_core.luminance.mean <
      regions.lit_floor.luminance.mean * 0.82,
    `Cornell shadow core is not darker than the lit floor: ${
      JSON.stringify(regions)
    }`,
  );
  assert.ok(
    regions.penumbra_edge.luminance.mean >
        regions.penumbra_core.luminance.mean &&
      regions.penumbra_edge.luminance.mean <
        regions.lit_floor.luminance.mean,
    `Cornell penumbra edge is not between shadow and light: ${
      JSON.stringify(regions)
    }`,
  );
  assert.ok(
    regions.mirror.blue_dominant_fraction > 0.004,
    `Cornell mirror omitted the off-camera blue object: ${
      JSON.stringify(regions.mirror)
    }`,
  );
  assert.ok(
    regions.indirect_shadow.luminance.mean >
        single_bounce.regions.indirect_shadow.luminance.mean * 2 &&
      regions.indirect_shadow.luminance.mean >
        single_bounce.regions.indirect_shadow.luminance.mean + 2,
    `Cornell multi-bounce indirect light did not lift the neutral floor shadow: ${
      JSON.stringify({
        multi_bounce: regions.indirect_shadow,
        single_bounce: single_bounce.regions.indirect_shadow,
      })
    }`,
  );
}

function assert_fog_regions(proof) {
  const { regions } = proof;
  const failures = [];
  if (
    regions.loaded_geometry.luminance.p90 -
        regions.loaded_geometry.luminance.p10 <= 18
  ) failures.push("loaded geometry lacks depth contrast");
  if (
    regions.emissive.mean.b <= regions.emissive.mean.r * 1.5 ||
    regions.emissive.luminance.mean <= 30
  ) failures.push("emissive lamp is missing");
  if (
    regions.shadow_core.luminance.mean >=
      regions.lit_floor.luminance.mean * 0.5 ||
    regions.shadow_edge.luminance.mean <=
      regions.shadow_core.luminance.mean * 2 ||
    regions.shadow_edge.luminance.mean >=
      regions.lit_floor.luminance.mean * 0.9
  ) failures.push("area-light shadow lacks a soft core-to-light transition");
  assert.deepEqual(
    failures,
    [],
    `Fog pixel proof failed: ${failures.join("; ")}; ${
      JSON.stringify(region_diagnostics(proof))
    }`,
  );
}

function assert_fog_normal_mapping(normal_mapped, flat_normal_control) {
  const mapped = normal_mapped.regions.normal_detail;
  const flat = flat_normal_control.regions.normal_detail;
  assert.equal(mapped.temporal_samples.length, flat.temporal_samples.length);
  const root_mean_square = Math.sqrt(
    mapped.temporal_samples.reduce(
      (sum, value, index) => sum + (value - flat.temporal_samples[index]) ** 2,
      0,
    ) / mapped.temporal_samples.length,
  );
  assert.ok(
    root_mean_square > 4,
    `Fog normal-mapped surface must differ from its flat-normal control: ${
      JSON.stringify({
        flat_normal: flat.luminance,
        normal_mapped: mapped.luminance,
        root_mean_square,
      })
    }`,
  );
}

function assert_fog_material_reflections(specular, diffuse_control) {
  const failures = [];
  const comparisons = {};
  for (const name of ["ceramic", "brass"]) {
    const reflected = specular.regions[name].luminance;
    const diffuse = diffuse_control.regions[name].luminance;
    const reflected_highlight = reflected.p99 - reflected.p50;
    const diffuse_highlight = diffuse.p99 - diffuse.p50;
    comparisons[name] = {
      diffuse_highlight,
      diffuse_luminance: diffuse,
      reflected_highlight,
      reflected_luminance: reflected,
    };
    if (
      reflected_highlight <= diffuse_highlight * 1.2 ||
      reflected_highlight <= diffuse_highlight + 10
    ) {
      failures.push(`${name} lacks a reflection-caused highlight tail`);
    }
  }
  assert.deepEqual(
    failures,
    [],
    `Fog specular materials must exceed their same-albedo diffuse controls: ${
      JSON.stringify(comparisons)
    }`,
  );
}

function assert_bounded_temporal_variance(first, second) {
  const deviations = {};
  for (const name of Object.keys(fog_regions)) {
    const before = first.regions[name].temporal_samples;
    const after = second.regions[name].temporal_samples;
    assert.equal(before.length, after.length);
    const root_mean_square = Math.sqrt(
      before.reduce(
        (sum, value, index) => sum + (value - after[index]) ** 2,
        0,
      ) / before.length,
    );
    deviations[name] = root_mean_square;
  }
  assert.ok(
    Object.values(deviations).every((deviation) => deviation < 12),
    `Fog post-denoise temporal deviations must remain below 12: ${
      JSON.stringify(deviations)
    }`,
  );
}

function region_diagnostics(proof) {
  return Object.fromEntries(
    Object.entries(proof.regions).map(([name, region]) => [name, {
      blue_dominant_fraction: region.blue_dominant_fraction,
      luminance: region.luminance,
      mean: region.mean,
    }]),
  );
}
