import assert from "node:assert/strict";
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
import { createServer } from "vite";

const application_directory = fileURLToPath(new URL("../", import.meta.url));
const project_file = fileURLToPath(
  new URL("../blot.json", import.meta.url),
);
const main_file = fileURLToPath(
  new URL("blot/main.blot", import.meta.url),
);
const recipe_file = fileURLToPath(
  new URL("blot/recipe.blot", import.meta.url),
);
const development_descriptor_file = fileURLToPath(
  new URL("../generated/shrubbery.development.json", import.meta.url),
);

test(
  "the browser atomically activates a retained provider and recovers from a failed activation",
  { timeout: 120_000 },
  async () => {
    const temporary_directory = await mkdtemp(
      join(application_directory, ".ink-development-test-"),
    );
    const temporary_source_directory = join(
      temporary_directory,
      "src",
      "blot",
    );
    const temporary_project = join(temporary_directory, "blot.json");
    const temporary_recipe = join(
      temporary_source_directory,
      "recipe.blot",
    );
    await mkdir(temporary_source_directory, { recursive: true });
    await Promise.all([
      copyFile(project_file, temporary_project),
      copyFile(main_file, join(temporary_source_directory, "main.blot")),
      copyFile(recipe_file, temporary_recipe),
    ]);
    const previous_project = process.env.INK_SHRUBBERY_PROJECT;
    const previous_descriptor = await read_optional_file(
      development_descriptor_file,
    );
    process.env.INK_SHRUBBERY_PROJECT = temporary_project;

    let server;
    let browser;
    try {
      const { default: configure } = await import(
        `../ink.ts?browser=${crypto.randomUUID()}`
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
          `shrubbery browser server returned invalid address ${
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
        viewport: { width: 960, height: 640 },
      });
      const browser_errors = [];
      page.on("crash", () => browser_errors.push("page crashed"));
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
      await install_evidence_capture(page);
      await page.goto(origin, { waitUntil: "domcontentloaded" });

      const initial = await wait_for_evidence(page, {
        type: "ready",
        selected_name: "mixed shrubbery",
      }, browser_errors);
      assert.equal(initial.entry_retained, false);
      assert_presentation_evidence(initial);
      await assert_presentation_status(page);
      const initial_descriptor = await fetch_descriptor(origin);
      assert_development_revision(initial_descriptor, {
        base_revision: null,
        changed_units: ["game", "recipe"],
        retained_units: [],
      });
      assert.equal(initial.revision, initial_descriptor.revision);
      await page.getByRole("button", { name: "oak", exact: true }).click();
      await page.waitForFunction(() =>
        document.querySelector("#selection")?.textContent === "oak"
      );

      await writeFile(temporary_recipe, recipe_source(2), "utf8");
      const edited = await wait_for_evidence(page, {
        type: "ready",
        selected_name: "edited oak",
        previous_revision: initial.revision,
      }, browser_errors);
      assert.equal(edited.entry_retained, true);
      assert_presentation_evidence(edited);
      const edited_descriptor = await fetch_descriptor(origin);
      assert_development_revision(edited_descriptor, {
        base_revision: initial.revision,
        changed_units: ["recipe"],
        retained_units: ["game"],
      });
      assert.equal(edited.revision, edited_descriptor.revision);

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
      await writeFile(temporary_recipe, recipe_source(3), "utf8");
      const failed = await wait_for_evidence(page, {
        type: "failed",
        selected_name: "edited oak",
      }, browser_errors);
      assert.equal(failed.revision, edited.revision);
      assert.equal(corrupt_next_wasm, false);
      assert.equal(
        await page.locator("#selection").textContent(),
        "edited oak",
      );
      const failed_descriptor = await fetch_descriptor(origin);
      assert_development_revision(failed_descriptor, {
        base_revision: edited.revision,
        changed_units: ["recipe"],
        retained_units: ["game"],
      });

      await writeFile(temporary_recipe, recipe_source(4), "utf8");
      const recovered = await wait_for_evidence(page, {
        type: "ready",
        selected_name: "recovered oak",
        previous_revision: edited.revision,
      }, browser_errors);
      assert.equal(recovered.entry_retained, false);
      assert_presentation_evidence(recovered);
      await assert_presentation_status(page);
      const recovered_descriptor = await fetch_descriptor(origin);
      assert_development_revision(recovered_descriptor, {
        base_revision: failed_descriptor.revision,
        changed_units: ["recipe"],
        retained_units: ["game"],
      });
      assert.equal(recovered.revision, recovered_descriptor.revision);
      assert.equal(
        await page.locator("#selection").textContent(),
        "recovered oak",
      );

      const evidence_history = await page.evaluate(() =>
        globalThis.__inkShrubberyEvidence
      );
      assert.deepEqual(
        evidence_history.filter(({ type }) => type === "ready"),
        [initial, edited, recovered],
      );
      assert.deepEqual(browser_errors, []);
    } finally {
      await browser?.close();
      await server?.close();
      if (previous_project === undefined) {
        delete process.env.INK_SHRUBBERY_PROJECT;
      } else {
        process.env.INK_SHRUBBERY_PROJECT = previous_project;
      }
      if (previous_descriptor === undefined) {
        await rm(development_descriptor_file, { force: true });
      } else {
        await writeFile(development_descriptor_file, previous_descriptor);
      }
      await rm(temporary_directory, { recursive: true, force: true });
    }
  },
);

function recipe_source(appended_selections) {
  const values = Array.from(
    { length: appended_selections },
    () => "request.selection",
  ).join(", ");
  return `open import "blot:prelude"

let revise = fn request => {
  .selection = request.selection;
  .values = [...request.values, ${values}];
}

return { .revise = revise; }
`;
}

async function install_evidence_capture(page) {
  await page.addInitScript(() => {
    globalThis.__inkShrubberyEvidence = [];
    globalThis.addEventListener("DOMContentLoaded", () => {
      const capture = () => {
        const source = document.body.dataset.developmentEvidence;
        if (source === undefined) return;
        const evidence = JSON.parse(source);
        const previous = globalThis.__inkShrubberyEvidence.at(-1);
        if (JSON.stringify(previous) === JSON.stringify(evidence)) return;
        globalThis.__inkShrubberyEvidence.push(evidence);
      };
      new MutationObserver(capture).observe(document.body, {
        attributes: true,
        attributeFilter: ["data-development-evidence"],
      });
      capture();
    }, { once: true });
  });
}

async function wait_for_evidence(page, expected, browser_errors) {
  try {
    await page.waitForFunction(
      (target) => {
        const source = document.body.dataset.developmentEvidence;
        if (source === undefined) return false;
        const evidence = JSON.parse(source);
        return evidence.type === target.type &&
          evidence.selected_name === target.selected_name &&
          (target.previous_revision === undefined ||
            evidence.revision !== target.previous_revision);
      },
      expected,
      { polling: 10 },
    );
  } catch (cause) {
    const diagnostics = await page.evaluate(() => ({
      evidence: document.body.dataset.developmentEvidence,
      selection: document.querySelector("#selection")?.textContent,
      status: document.querySelector("#status")?.textContent,
    }));
    throw new Error(
      `shrubbery development did not reach ${JSON.stringify(expected)}: ${
        JSON.stringify({ diagnostics, browser_errors })
      }`,
      { cause },
    );
  }
  return await page.evaluate(() =>
    JSON.parse(document.body.dataset.developmentEvidence)
  );
}

async function assert_presentation_status(page) {
  const status = await page.locator("#status").textContent();
  assert.match(status, /perspective Blot camera · -0\.25 EV/);
}

function assert_presentation_evidence(evidence) {
  assert.equal(evidence.camera_type, "perspective");
  assert.equal(evidence.exposure_ev100, -0.25);
}

async function fetch_descriptor(origin) {
  const response = await fetch(
    `${origin}/shrubbery.development.json?test=${crypto.randomUUID()}`,
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
    ["game", "recipe"],
  );
  assert.deepEqual(
    descriptor.snapshot.edges.map(({ consumer, provider }) => ({
      consumer,
      provider,
    })),
    [{ consumer: "game", provider: "recipe" }],
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

async function read_optional_file(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (
      error instanceof Error && "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}
