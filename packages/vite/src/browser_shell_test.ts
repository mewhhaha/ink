import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "vite";
import { define_ink_game } from "./config.ts";

test("Ink Vite builds its browser shell without application entry files", async () => {
  const app_directory = await mkdtemp(join(tmpdir(), "ink-browser-shell-"));
  const source_directory = join(app_directory, "src");
  const output_directory = join(app_directory, "dist");
  await mkdir(source_directory);
  await writeFile(
    join(source_directory, "adapter.ts"),
    "export function create_artifact_loader() { return async () => { throw new Error('fixture is not executed'); }; }\n",
  );
  await writeFile(
    join(source_directory, "editor.tsx"),
    "export function render_fixture_editor() { return 'fixture-editor-marker'; }\n",
  );

  try {
    const configure = define_ink_game({
      adapter: {
        artifact_name: "fixture",
        browser_module: pathToFileURL(join(source_directory, "adapter.ts")),
        browser_factory: "create_artifact_loader",
        configuration: null,
      },
      app_directory: pathToFileURL(`${app_directory}/`),
      development: {
        auto_play: true,
        keyboard_actions: { k: "agent-leap" },
        show_transport: false,
      },
      editor: {
        browser_module: pathToFileURL(join(source_directory, "editor.tsx")),
        browser_export: "render_fixture_editor",
      },
      source_directories: [],
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
    assert.match(html, /<div id="root"><\/div>/);
    assert.match(html, /<script type="module" crossorigin src="\/assets\//);
    const asset_files = await readdir(join(output_directory, "assets"));
    const scripts = await Promise.all(
      asset_files.filter((file) => file.endsWith(".js")).map((file) =>
        readFile(join(output_directory, "assets", file), "utf8")
      ),
    );
    assert(scripts.some((script) => script.includes("agent-leap")));
    assert(scripts.some((script) => script.includes("fixture-editor-marker")));
    assert(scripts.some((script) => script.includes("ink-development:")));
    assert(scripts.some((script) => script.includes("/editor")));
    assert(scripts.some((script) => script.includes("/game")));
  } finally {
    await rm(app_directory, { recursive: true });
  }
});
