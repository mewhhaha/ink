import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Plugin, PluginOption, UserConfig } from "vite";
import { define_ink_game } from "./config.ts";

const config_environment = {
  command: "serve" as const,
  mode: "test",
  isSsrBuild: false,
  isPreview: false,
};
const fixture_adapter = {
  artifact_name: "example",
  browser_module: new URL("./fixture_adapter.ts", import.meta.url),
  browser_factory: "create_artifact_loader",
  configuration: null,
} as const;

test("Ink Vite supplies the complete browser development configuration", async () => {
  const configure = define_ink_game({
    adapter: fixture_adapter,
    app_directory: new URL("file:///games/example/"),
    source_directories: ["guest-source/"],
  });
  const config = await configure(config_environment);

  assert.deepEqual(config.server, { open: false });
  assert.deepEqual(config.build, {
    emptyOutDir: true,
    minify: "oxc",
    outDir: "/games/example/dist/",
  });
  assert.equal(
    config.root,
    fileURLToPath(new URL("../browser/", import.meta.url)),
  );
  assert(plugin_names(config).includes("ink-browser-shell"));
  assert(plugin_names(config).includes("ink-game-development"));
  assert(plugin_names(config).includes("vite:react-babel"));
  assert(
    plugin_names(config).some((name) => name.startsWith("@tailwindcss/vite:")),
  );
});

test("Ink Vite remains language-neutral and resolves declared directories", async () => {
  const configure = define_ink_game({
    adapter: fixture_adapter,
    app_directory: new URL("file:///games/example/"),
    source_directories: ["rust-source/", "generated-bindings/"],
    resource_directories: [{
      source_directory: "art/",
      public_directory: "published/art/",
    }],
    public_directory: "published/",
    web_directory: "browser/",
    output_directory: "release/",
    build: {
      command: "cargo",
      arguments: ["build", "--target", "wasm32-unknown-unknown"],
      working_directory: "rust-source/",
    },
  });
  const config = await configure(config_environment);
  assert.equal(config.root, "/games/example/browser/");
  assert.equal(config.build?.outDir, "/games/example/release/");
  const plugin = ink_plugin(config);
  const watched_directories: string[][] = [];

  const configure_server = plugin.configureServer;
  assert(typeof configure_server === "function");
  configure_server.call({} as never, {
    watcher: {
      add(paths: string[]) {
        watched_directories.push(paths);
      },
    },
  } as never);

  assert.deepEqual(watched_directories, [[
    "/games/example/rust-source/",
    "/games/example/generated-bindings/",
    "/games/example/art/",
  ]]);
  const configure_plugin = plugin.config;
  assert(typeof configure_plugin === "function");
  assert.deepEqual(
    configure_plugin.call({} as never, {} as never, {} as never),
    { publicDir: "/games/example/published/" },
  );
});

test("Ink Vite rejects non-file application directories with evidence", () => {
  assert.throws(
    () =>
      define_ink_game({
        adapter: fixture_adapter,
        app_directory: new URL("https://example.com/game/"),
        source_directories: ["source/"],
      }),
    /app_directory "https:\/\/example\.com\/game\/" must be a file URL/,
  );
});

test("Ink Vite rejects artifact names that cannot be published safely", () => {
  assert.throws(
    () =>
      define_ink_game({
        adapter: { ...fixture_adapter, artifact_name: "../other-game" },
        app_directory: new URL("file:///games/example/"),
        source_directories: ["source/"],
      }),
    /adapter\.artifact_name "\.\.\/other-game" must be a file name/,
  );
});

test("Ink Vite rejects an empty editor export", () => {
  assert.throws(
    () =>
      define_ink_game({
        adapter: fixture_adapter,
        app_directory: new URL("file:///games/example/"),
        editor: {
          browser_module: "src/editor.tsx",
          browser_export: "",
        },
        source_directories: ["source/"],
      }),
    /editor\.browser_export must not be empty/,
  );
});

test("Ink Vite rejects output directories that overlap project inputs", () => {
  assert.throws(
    () =>
      define_ink_game({
        adapter: fixture_adapter,
        app_directory: new URL("file:///games/example/"),
        source_directories: ["source/"],
        output_directory: "source/release/",
      }),
    /output_directory "file:\/\/\/games\/example\/source\/release\/" must not overlap source_directories\[0\] "file:\/\/\/games\/example\/source\/"/,
  );
  assert.throws(
    () =>
      define_ink_game({
        adapter: fixture_adapter,
        app_directory: new URL("file:///games/example/"),
        source_directories: ["source/"],
        output_directory: ".",
      }),
    /must not contain app_directory/,
  );
});

test("Ink Vite rejects resource outputs outside the public directory", () => {
  assert.throws(
    () =>
      define_ink_game({
        adapter: fixture_adapter,
        app_directory: new URL("file:///games/example/"),
        source_directories: ["source/"],
        public_directory: "public/",
        resource_directories: [{
          source_directory: "assets/",
          public_directory: "elsewhere/",
        }],
      }),
    /resource_directories\[0\]\.public_directory .* must be inside public_directory/,
  );
});

test("Ink Vite rejects build and adapter values that would be coerced", () => {
  assert.throws(
    () =>
      define_ink_game({
        adapter: fixture_adapter,
        app_directory: new URL("file:///games/example/"),
        source_directories: [],
        build: { command: " ", arguments: [] },
      }),
    /build\.command " " must be a non-empty string/,
  );
  assert.throws(
    () =>
      define_ink_game({
        adapter: {
          ...fixture_adapter,
          configuration: { exposure: Number.POSITIVE_INFINITY },
        },
        app_directory: new URL("file:///games/example/"),
        source_directories: [],
      }),
    /property "exposure" contains non-finite number Infinity/,
  );
  assert.throws(
    () =>
      define_ink_game({
        adapter: fixture_adapter,
        app_directory: new URL("file:///games/example/"),
        development: {
          logical_viewport: {
            width: Number.POSITIVE_INFINITY,
            height: 540,
          },
        },
        source_directories: [],
      }),
    /Ink Vite development must be JSON serializable: property "width" contains non-finite number Infinity/,
  );
});

function ink_plugin(config: UserConfig): Plugin {
  const plugin = flatten_plugins(config.plugins ?? []).find((candidate) =>
    candidate.name === "ink-game-development"
  );
  assert(plugin, "Ink Vite did not install the Ink development plugin");
  return plugin;
}

function plugin_names(config: UserConfig): readonly string[] {
  return flatten_plugins(config.plugins ?? []).flatMap((plugin) =>
    plugin.name ? [plugin.name] : []
  );
}

function flatten_plugins(plugins: readonly PluginOption[]): Plugin[] {
  const flattened: Plugin[] = [];
  for (const plugin of plugins) {
    if (!plugin) continue;
    if (Array.isArray(plugin)) {
      flattened.push(...flatten_plugins(plugin));
      continue;
    }
    if (plugin instanceof Promise) continue;
    flattened.push(plugin);
  }
  return flattened;
}
