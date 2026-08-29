import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "vite";
import { define_ink_application } from "./config.ts";

test("Ink Vite builds an ordinary non-Blot application entry", async () => {
  const app_directory = await mkdtemp(join(tmpdir(), "ink-vite-app-"));
  const source_directory = join(app_directory, "src");
  const output_directory = join(app_directory, "dist");
  await mkdir(source_directory);
  await writeFile(
    join(app_directory, "index.html"),
    '<!doctype html><main id="root"></main><script type="module" src="/src/main.js"></script>',
  );
  await writeFile(
    join(source_directory, "main.js"),
    'document.querySelector("#root").textContent = "language-neutral fixture";\n',
  );

  try {
    const configure = define_ink_application({
      app_directory: pathToFileURL(`${app_directory}/`),
      source_directories: [pathToFileURL(`${source_directory}/`)],
      resource_directories: [],
      public_directory: pathToFileURL(`${app_directory}/generated/`),
      output_directory: pathToFileURL(`${output_directory}/`),
      build: {
        command: process.execPath,
        arguments: ["-e", ""],
      },
    });
    const config = await configure({
      command: "build",
      mode: "test",
      isSsrBuild: false,
      isPreview: false,
    });
    await build({ ...config, configFile: false, logLevel: "silent" });

    const html = await readFile(join(output_directory, "index.html"), "utf8");
    assert.match(html, /<main id="root"><\/main>/);
    assert.match(html, /<script type="module" crossorigin src="\/assets\//);
    const javascript = await readFile(
      join(
        output_directory,
        html.match(/src="(\/assets\/[^"]+\.js)"/)![1],
      ),
      "utf8",
    );
    assert.match(javascript, /language-neutral fixture/);
  } finally {
    await rm(app_directory, { recursive: true });
  }
});
