import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plugin, PluginOption, UserConfig } from "vite";
import { define_ink_application } from "./config.ts";

const config_environment = {
  command: "serve" as const,
  mode: "test",
  isSsrBuild: false,
  isPreview: false,
};

test("Ink Vite supplies language-neutral application paths and watching", async () => {
  const configure = define_ink_application({
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
  assert.deepEqual(config.server, { open: false });
  assert.deepEqual(plugin_names(config), ["ink-application-development"]);

  const plugin = ink_plugin(config);
  const watched_directories: string[][] = [];
  const configure_server = plugin.configureServer;
  assert.equal(typeof configure_server, "function");
  if (typeof configure_server !== "function") {
    throw new Error("Ink Vite configureServer hook is not callable");
  }
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
  assert.equal(typeof configure_plugin, "function");
  if (typeof configure_plugin !== "function") {
    throw new Error("Ink Vite config hook is not callable");
  }
  assert.deepEqual(
    configure_plugin.call({} as never, {} as never, {} as never),
    { publicDir: "/games/example/published/" },
  );
});

test("Ink Vite defaults to the application's ordinary index", async () => {
  const configure = define_ink_application({
    app_directory: new URL("file:///games/example/"),
    source_directories: ["guest/"],
  });
  const config = await configure(config_environment);
  assert.equal(config.root, "/games/example/");
  assert.equal(config.build?.outDir, "/games/example/dist/");
});

test("Ink Vite rejects unsafe directories and malformed build commands", () => {
  assert.throws(
    () =>
      define_ink_application({
        app_directory: new URL("https://example.com/game/"),
        source_directories: [],
      }),
    /app_directory "https:\/\/example\.com\/game\/" must be a file URL/,
  );
  assert.throws(
    () =>
      define_ink_application({
        app_directory: new URL("file:///games/example/"),
        source_directories: [],
        build: { command: " ", arguments: [] },
      }),
    /build\.command " " must be a non-empty string/,
  );
  assert.throws(
    () =>
      define_ink_application({
        app_directory: new URL("file:///games/example/"),
        source_directories: ["source/"],
        output_directory: "source/release/",
      }),
    /must not overlap source_directories\[0\]/,
  );
});

test("Ink Vite keeps resource publications inside the public directory", () => {
  assert.throws(
    () =>
      define_ink_application({
        app_directory: new URL("file:///games/example/"),
        source_directories: [],
        public_directory: "public/",
        resource_directories: [{
          source_directory: "assets/",
          public_directory: "elsewhere/",
        }],
      }),
    /resource_directories\[0\]\.public_directory .* must be inside public_directory/,
  );
});

function ink_plugin(config: UserConfig): Plugin {
  const plugin = flatten_plugins(config.plugins ?? []).find((candidate) =>
    candidate.name === "ink-application-development"
  );
  assert(plugin, "Ink Vite did not install its development plugin");
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
