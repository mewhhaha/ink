/** Development only. No Playwright, driver or browser dependency in Ink. */
import { pathToFileURL } from "node:url";
import {
  cacheFiles,
  installCache,
  recoverCache,
  sealCache,
  validCache,
} from "./cache.ts";
const cache = new URL("../.cache/chrome/", import.meta.url);
const installed = new URL("chrome-linux64/chrome", cache);

async function exists(path: string | URL): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export async function browserVersion(path: string): Promise<string> {
  const result = await new Deno.Command(path, {
    args: ["--version"],
    signal: AbortSignal.timeout(5000),
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error(`Browser version failed: ${path}`);
  return new TextDecoder().decode(result.stdout).trim();
}

export async function cachedBrowserPath(
  root = cache,
): Promise<string | undefined> {
  const binary = new URL("chrome-linux64/chrome", root);
  await recoverCache(root);
  if (await exists(binary)) {
    if (!await exists(new URL(".setup-manifest.json", root))) return;
    try {
      const version = await browserVersion(binary.pathname);
      const required = [
        "chrome-linux64/chrome",
        "chrome-linux64/icudtl.dat",
        "chrome-linux64/resources.pak",
      ];
      for (const file of required) {
        if (!await exists(new URL(file, root))) return;
      }
      const files = await cacheFiles(root);
      if (await validCache(root, version, [...required, ...files])) {
        return binary.pathname;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        console.warn(`Ignoring incomplete Chromium cache: ${error}`);
      }
    }
  }
}

export async function browserPath(): Promise<string | undefined> {
  const explicit = Deno.env.get("INK_CHROME");
  if (explicit) {
    if (!await exists(explicit)) {
      throw new Error(`INK_CHROME is missing: ${explicit}`);
    }
    return explicit;
  }
  const cached = await cachedBrowserPath();
  if (cached) return cached;
  // Reuse a development machine's existing browser before downloading one.
  for (
    const path of [
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ]
  ) {
    if (await exists(path)) return path;
  }
  const home = Deno.env.get("HOME");
  if (home) {
    const playwright = `${home}/.cache/ms-playwright`;
    try {
      const entries = await Array.fromAsync(Deno.readDir(playwright));
      entries.sort((a, b) =>
        b.name.localeCompare(a.name, undefined, { numeric: true })
      );
      for (const entry of entries) {
        if (entry.isDirectory && /^chromium-\d+$/.test(entry.name)) {
          const path = `${playwright}/${entry.name}/chrome-linux64/chrome`;
          if (await exists(path)) return path;
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

export async function setupBrowser(update = false): Promise<string> {
  let path: string | undefined;
  if (!update) path = await browserPath();
  if (path) return path;
  if (Deno.build.os !== "linux" || Deno.build.arch !== "x86_64") {
    throw new Error("Set INK_CHROME to Chromium on this platform.");
  }
  const response = await fetch(
    "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json",
  );
  if (!response.ok) throw new Error(`Chrome metadata: HTTP ${response.status}`);
  const data = await response.json();
  const channel = data.channels.Stable;
  const download = channel.downloads.chrome.find((item: { platform: string }) =>
    item.platform === "linux64"
  );
  const parent = new URL("../.cache/", import.meta.url);
  await Deno.mkdir(parent, { recursive: true });
  const stagePath = await Deno.makeTempDir({
    dir: parent.pathname,
    prefix: "chrome-setup-",
  });
  const stage = pathToFileURL(`${stagePath}/`);
  try {
    console.log(
      `Downloading Chrome for Testing ${channel.version} (cached after this run)`,
    );
    const archive = new URL("chrome.zip", stage);
    const binary = await fetch(download.url);
    if (!binary.ok || !binary.body) {
      throw new Error(`Chrome download: HTTP ${binary.status}`);
    }
    await binary.body.pipeTo(
      (await Deno.open(archive, { write: true, createNew: true })).writable,
    );
    const unzip = await new Deno.Command("unzip", {
      args: ["-q", archive.pathname, "-d", stage.pathname],
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (!unzip.success) throw new Error("Cannot unpack Chromium");
    await Deno.remove(archive);
    const version = await browserVersion(
      new URL("chrome-linux64/chrome", stage).pathname,
    );
    const required = [
      "chrome-linux64/chrome",
      "chrome-linux64/icudtl.dat",
      "chrome-linux64/resources.pak",
    ];
    await sealCache(stage, version, await cacheFiles(stage));
    if (!await validCache(stage, version, required)) {
      throw new Error("Incomplete Chromium payload");
    }
    await installCache(stage, cache);
    return installed.pathname;
  } finally {
    await Deno.remove(stage, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
}

if (import.meta.main) {
  const path = await setupBrowser(Deno.args.includes("--update"));
  console.log(`Browser ready: ${path} (${await browserVersion(path)})`);
}
