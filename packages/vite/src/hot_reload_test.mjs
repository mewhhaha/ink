import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { define_ink_game } from "./config.ts";

let browser;
let page;
let server;
let fixture_directory;
let resource_directory;
let public_resource_directory;
let navigation_count;
let navigation_id;

before(async () => {
  fixture_directory = await mkdtemp(join(tmpdir(), "ink-browser-reload-"));
  resource_directory = join(fixture_directory, "resources");
  const public_directory = join(fixture_directory, "public");
  public_resource_directory = join(public_directory, "assets");
  await mkdir(resource_directory, { recursive: true });
  await mkdir(public_resource_directory, { recursive: true });
  await writeFile(join(resource_directory, "watched.txt"), "first");
  await writeFile(join(public_resource_directory, "watched.txt"), "first");
  await writeFile(
    join(fixture_directory, "index.html"),
    '<main id="content">Ink hot reload browser fixture</main><script type="module" src="/client.js"></script>',
  );
  const hot_reload_module = new URL(
    "../../development/hot_reload.ts",
    import.meta.url,
  ).pathname;
  await writeFile(
    join(fixture_directory, "client.js"),
    `import { subscribe_to_game_updates } from "/@fs/${hot_reload_module}";

const tracked_resources = new Set(["/assets/watched.txt"]);
window.inkBrowserReload = {
  events: [],
  navigationId: crypto.randomUUID(),
  resources: {},
};
window.trackResource = (path) => tracked_resources.add(path);

const reload_resources = async () => {
  for (const path of tracked_resources) {
    const response = await fetch(path + "?reload=" + crypto.randomUUID());
    window.inkBrowserReload.resources[path] = {
      body: response.ok ? await response.text() : "",
      status: response.status,
    };
  }
};

window.initialResourcesReady = reload_resources();
subscribe_to_game_updates(import.meta.hot, async (update) => {
  window.inkBrowserReload.events.push(update);
  if (update.type === "resources") await reload_resources();
});
`,
  );

  const ink_config = await define_ink_game({
    adapter: {
      artifact_name: "fixture",
      browser_module: pathToFileURL(join(fixture_directory, "client.js")),
      browser_factory: "create_artifact_loader",
      configuration: null,
    },
    app_directory: pathToFileURL(`${fixture_directory}/`),
    source_directories: [],
    resource_directories: [{
      source_directory: pathToFileURL(`${resource_directory}/`),
      public_directory: pathToFileURL(`${public_resource_directory}/`),
    }],
    public_directory: pathToFileURL(`${public_directory}/`),
    build: {
      command: process.execPath,
      arguments: ["-e", ""],
      working_directory: pathToFileURL(`${fixture_directory}/`),
    },
  })({
    command: "serve",
    mode: "test",
    isSsrBuild: false,
    isPreview: false,
  });
  server = await createServer({
    ...ink_config,
    root: fixture_directory,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Vite did not expose its browser test port");
  }

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  navigation_count = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigation_count += 1;
  });
  await page.goto(`http://127.0.0.1:${address.port}`, {
    waitUntil: "domcontentloaded",
  });
  await page.evaluate(() => globalThis.initialResourcesReady);
  navigation_count = 0;
  navigation_id = await page.evaluate(() =>
    globalThis.inkBrowserReload.navigationId
  );
});

after(async () => {
  await browser?.close();
  await server?.close();
  if (fixture_directory) await rm(fixture_directory, { recursive: true });
});

test("an updated resource reloads without navigating the page", async () => {
  await writeFile(join(resource_directory, "watched.txt"), "second");

  await wait_for_resource("/assets/watched.txt", {
    body: "second",
    status: 200,
  });
  await assert_page_was_not_reloaded();
  assert.equal(
    await readFile(join(public_resource_directory, "watched.txt"), "utf8"),
    "second",
  );
});

test("a new nested resource appears without navigating the page", async () => {
  const nested_resource_directory = join(resource_directory, "terrain");
  await page.evaluate(() =>
    globalThis.trackResource("/assets/terrain/new.txt")
  );
  await mkdir(nested_resource_directory, { recursive: true });
  await writeFile(join(nested_resource_directory, "new.txt"), "new terrain");

  await wait_for_resource("/assets/terrain/new.txt", {
    body: "new terrain",
    status: 200,
  });
  await assert_page_was_not_reloaded();
});

test("a deleted resource disappears without navigating the page", async () => {
  await rm(join(resource_directory, "watched.txt"));

  await page.waitForFunction(() =>
    globalThis.inkBrowserReload.resources["/assets/watched.txt"]?.body !==
      "second"
  );
  await assert_page_was_not_reloaded();
  await assert.rejects(
    readFile(join(public_resource_directory, "watched.txt"), "utf8"),
  );
});

test("rapid resource updates settle on the latest contents", async () => {
  const watched_resource = join(resource_directory, "watched.txt");
  await writeFile(watched_resource, "third");
  await writeFile(watched_resource, "fourth");

  await wait_for_resource("/assets/watched.txt", {
    body: "fourth",
    status: 200,
  });
  await assert_page_was_not_reloaded();
});

async function wait_for_resource(path, expected) {
  await page.waitForFunction(
    ({ path, expected }) => {
      const resource = globalThis.inkBrowserReload.resources[path];
      return resource?.body === expected.body &&
        resource.status === expected.status;
    },
    { path, expected },
  );
}

async function assert_page_was_not_reloaded() {
  assert.equal(navigation_count, 0);
  assert.equal(
    await page.evaluate(() => globalThis.inkBrowserReload.navigationId),
    navigation_id,
  );
  assert.equal(
    await page.evaluate(() => globalThis.inkBrowserReload.events.at(-1)?.type),
    "resources",
  );
}
