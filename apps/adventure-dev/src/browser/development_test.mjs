import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import {
  parse_adventure_document,
  serialize_adventure_document,
} from "@ink/adventure-editor/document.ts";
import { apply_adventure_layout_command } from "@ink/adventure-editor/layout.ts";

const application_directory = fileURLToPath(new URL("../../", import.meta.url));
const starter_file = fileURLToPath(
  new URL("../../projects/starter.json", import.meta.url),
);
const generated_project_file = fileURLToPath(
  new URL("../../generated/adventure-project.json", import.meta.url),
);

test(
  "binding the placed oak gate hot-reloads without navigation and unlocks the exit",
  { timeout: 90_000 },
  async () => {
    const original_starter = await readFile(starter_file, "utf8");
    const starter = parse_adventure_document(original_starter);
    const initial_layout = apply_adventure_layout_command(starter.layout, {
      type: "bind_interaction",
      binding: {
        interaction: "unlock-exit",
        brush: "south-wall-west",
      },
    });
    const initial_source = serialize_adventure_document({
      ...starter,
      layout: initial_layout,
    });
    const temporary_directory = await mkdtemp(
      join(tmpdir(), "ink-adventure-development-"),
    );
    const temporary_project = join(temporary_directory, "starter.json");
    await writeFile(temporary_project, initial_source, "utf8");
    const previous_project_file = process.env.INK_ADVENTURE_PROJECT_FILE;
    process.env.INK_ADVENTURE_PROJECT_FILE = temporary_project;

    let server;
    let browser;
    try {
      const { default: configure } = await import(
        `../../ink.ts?development=${crypto.randomUUID()}`
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
          `adventure development server returned invalid address ${
            JSON.stringify(address)
          }`,
        );
      }
      const origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({
        viewport: { width: 960, height: 540 },
      });
      const browser_errors = [];
      let navigations = 0;
      page.on("pageerror", (error) => browser_errors.push(error.message));
      page.on("requestfailed", (request) => {
        browser_errors.push(
          `${request.method()} ${request.url()} failed: ${
            request.failure()?.errorText ?? "unknown error"
          }`,
        );
      });
      page.on("response", (response) => {
        if (response.status() < 400) return;
        browser_errors.push(
          `${response.request().method()} ${response.url()} returned ${response.status()}`,
        );
      });
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations += 1;
      });

      await page.goto(`${origin}/game`, { waitUntil: "domcontentloaded" });
      await wait_for_adventure_development(page, browser_errors);
      const initial_navigation_count = navigations;
      const initial_development = await development_evidence(page);
      assert.equal(initial_development.entry_retained, false);
      assert.equal(initial_development.state_preserved, false);
      const initial_descriptor = await fetch_descriptor(origin);
      assert_development_delta(initial_descriptor, {
        base_revision: null,
        changed: ["game", "project"],
        retained: [],
      });
      assert.equal(initial_development.revision, initial_descriptor.revision);
      await wait_for_generated_project(initial_source);
      await page.getByRole("button", {
        name: "Take brass key",
        exact: true,
      }).waitFor();

      const edited_source = serialize_adventure_document({
        ...starter,
        layout: apply_adventure_layout_command(initial_layout, {
          type: "bind_interaction",
          binding: {
            interaction: "unlock-exit",
            brush: "oak-gate",
          },
        }),
      });
      await writeFile(temporary_project, edited_source, "utf8");
      await wait_for_generated_project(edited_source);
      const activated = await wait_for_activation(
        page,
        initial_development.revision,
        browser_errors,
      );
      assert.equal(activated.entry_retained, true);
      assert.equal(activated.state_preserved, true);
      const edited_descriptor = await fetch_descriptor(origin);
      assert_development_delta(edited_descriptor, {
        base_revision: initial_descriptor.revision,
        changed: ["project"],
        retained: ["game"],
      });
      assert.equal(activated.revision, edited_descriptor.revision);
      assert.equal(navigations, initial_navigation_count);

      const application = page.locator("main");
      assert.equal(
        await application.getAttribute("data-gate-visible"),
        "true",
      );
      assert.equal(
        await page.getByRole("button", {
          name: "Unlock oak gate",
          exact: true,
        }).count(),
        0,
      );
      assert.equal(
        await page.getByRole("button", {
          name: "Enter the exit room",
          exact: true,
        }).count(),
        0,
      );

      await application.focus();
      await page.keyboard.down("KeyS");
      try {
        await wait_for_player_position(
          page,
          "[0,500000,3490000]",
          browser_errors,
        );
      } finally {
        await page.keyboard.up("KeyS");
      }

      await page.getByRole("button", {
        name: "Take brass key",
        exact: true,
      }).click();
      const unlock_gate = page.getByRole("button", {
        name: "Unlock oak gate",
        exact: true,
      });
      await unlock_gate.waitFor();
      assert.equal(
        await page.getByRole("button", {
          name: "Enter the exit room",
          exact: true,
        }).count(),
        0,
      );
      await unlock_gate.click();
      const enter_exit_room = page.getByRole("button", {
        name: "Enter the exit room",
        exact: true,
      });
      await enter_exit_room.waitFor();
      assert.equal(
        await application.getAttribute("data-gate-visible"),
        "false",
      );
      await enter_exit_room.click();
      await page.waitForFunction(
        () => {
          const source = document.querySelector("main")?.getAttribute(
            "data-semantic-observation",
          );
          return source !== null && source !== undefined &&
            JSON.parse(source).status.value === "Exit room reached";
        },
        undefined,
        { polling: 10 },
      );
      assert.equal(
        await application.getAttribute("data-player-position"),
        "[0,500000,4750000]",
      );
      assert.deepEqual(browser_errors, []);
    } finally {
      await browser?.close();
      await server?.close();
      delete process.env.INK_ADVENTURE_PROJECT_FILE;
      try {
        await rm(temporary_directory, { recursive: true, force: true });
        rebuild_starter_artifact();
        assert.equal(await readFile(starter_file, "utf8"), original_starter);
      } finally {
        if (previous_project_file !== undefined) {
          process.env.INK_ADVENTURE_PROJECT_FILE = previous_project_file;
        }
      }
    }
  },
);

async function wait_for_adventure_development(page, browser_errors) {
  try {
    await page.waitForFunction(
      () => {
        const application = document.querySelector("main");
        return application?.getAttribute("data-runtime-state") === "ready" &&
          application.getAttribute("data-development-status") === "ready";
      },
      undefined,
      { polling: 10 },
    );
  } catch (cause) {
    throw new Error(
      `adventure development runtime did not start: ${
        JSON.stringify({
          evidence: await development_evidence(page),
          browser_errors,
        })
      }`,
      { cause },
    );
  }
}

async function wait_for_activation(page, previous_revision, browser_errors) {
  try {
    await page.waitForFunction(
      (previous) => {
        const application = document.querySelector("main");
        return application?.getAttribute("data-development-status") ===
            "ready" &&
          application.getAttribute("data-development-revision") !== previous &&
          application.getAttribute("data-development-entry-retained") ===
            "true" &&
          application.getAttribute("data-development-state-preserved") ===
            "true";
      },
      previous_revision,
      { polling: 10 },
    );
  } catch (cause) {
    throw new Error(
      `adventure development activation did not complete: ${
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

async function wait_for_player_position(page, expected, browser_errors) {
  try {
    await page.waitForFunction(
      (position) =>
        document.querySelector("main")?.getAttribute(
          "data-player-position",
        ) === position,
      expected,
      { polling: 10 },
    );
  } catch (cause) {
    const runtime_evidence = await page.locator("main").evaluate(
      (application) => {
        const observation_source = application.dataset.semanticObservation;
        const observation = observation_source === undefined
          ? undefined
          : JSON.parse(observation_source);
        const active_element = document.activeElement;
        return {
          active_element: active_element instanceof HTMLElement
            ? active_element.outerHTML.slice(0, 240)
            : null,
          player_position: application.dataset.playerPosition,
          renderer_status: application.dataset.rendererStatus,
          runtime_sequence: application.dataset.runtimeSequence,
          runtime_state: application.dataset.runtimeState,
          status: observation?.status,
          actions: observation?.actions?.map(({ id }) => id),
        };
      },
    );
    throw new Error(
      `adventure player did not reach ${expected}: ${
        JSON.stringify({ runtime_evidence, browser_errors })
      }`,
      { cause },
    );
  }
}

async function fetch_descriptor(origin) {
  const response = await fetch(
    `${origin}/adventure_development.development.json?test=${crypto.randomUUID()}`,
    { cache: "no-store" },
  );
  assert.equal(response.status, 200);
  return await response.json();
}

function assert_development_delta(
  descriptor,
  { base_revision, changed, retained },
) {
  assert.equal(descriptor.format, "ink-blot-development-revision");
  assert.equal(descriptor.version, 1);
  assert.equal(descriptor.snapshot.entry_unit, "game");
  assert.equal(descriptor.delta.base_revision, base_revision);
  assert.deepEqual(
    descriptor.delta.changed_units.map(({ name }) => name),
    changed,
  );
  assert.deepEqual(
    descriptor.delta.retained_units.map(({ name }) => name),
    retained,
  );
}

async function wait_for_generated_project(expected_source) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if (await readFile(generated_project_file, "utf8") === expected_source) {
        return;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `adventure development build did not publish ${generated_project_file}`,
  );
}

function rebuild_starter_artifact() {
  const built = spawnSync("pnpm", ["build:game"], {
    cwd: application_directory,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(
    built.status,
    0,
    `adventure starter rebuild failed:\n${built.stdout}\n${built.stderr}`,
  );
}
