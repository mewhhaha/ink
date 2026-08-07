import { ink } from "@ink/development/vite.ts";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, UserConfigFnPromise } from "vite";

type DirectoryReference = string | URL;

export interface InkViteResourceDirectory {
  readonly source_directory: DirectoryReference;
  readonly public_directory: DirectoryReference;
}

export interface InkViteBuildCommand {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly working_directory?: DirectoryReference;
}

export interface InkViteGameAdapter {
  readonly artifact_name: string;
  readonly browser_module: URL;
  readonly browser_factory: string;
  readonly configuration: unknown;
}

export interface InkViteDevelopment {
  readonly always_enable_semantic_buttons?: boolean;
  readonly auto_play?: boolean;
  readonly keyboard_actions?: Readonly<
    Record<
      string,
      | string
      | { readonly pressed: string; readonly released: string }
    >
  >;
  readonly logical_viewport?: {
    readonly width: number;
    readonly height: number;
  };
  readonly gizmo_object_ranges?: readonly {
    readonly category: "collisions" | "areas";
    readonly first_object_id: number;
    readonly object_count: number;
    readonly box_mesh: number;
  }[];
  readonly semantic_interaction?: "activate" | "paint";
  readonly show_debugger?: boolean;
  readonly show_metrics?: boolean;
  readonly show_transport?: boolean;
}

export interface InkViteEditor {
  readonly browser_module: DirectoryReference;
  readonly browser_export: string;
}

export interface InkViteGame {
  readonly app_directory: URL;
  readonly adapter: InkViteGameAdapter;
  readonly development?: InkViteDevelopment;
  readonly editor?: InkViteEditor;
  readonly source_directories: readonly DirectoryReference[];
  readonly resource_directories?: readonly InkViteResourceDirectory[];
  readonly public_directory?: DirectoryReference;
  readonly web_directory?: DirectoryReference;
  readonly output_directory?: DirectoryReference;
  readonly build?: InkViteBuildCommand;
}

export function define_ink_game(game: InkViteGame): UserConfigFnPromise {
  const app_directory = file_directory(
    game.app_directory,
    game.app_directory,
    "app_directory",
  );
  const public_directory = file_directory(
    game.public_directory ?? "generated/",
    app_directory,
    "public_directory",
  );
  const web_directory = file_directory(
    game.web_directory ?? new URL("../browser/", import.meta.url),
    app_directory,
    "web_directory",
  );
  const output_directory = file_directory(
    game.output_directory ?? "dist/",
    app_directory,
    "output_directory",
  );
  const source_directories = game.source_directories.map((directory, index) =>
    file_directory(
      directory,
      app_directory,
      `source_directories[${index}]`,
    )
  );
  const declared_resources = game.resource_directories ?? [{
    source_directory: "assets/",
    public_directory: "generated/assets/",
  }];
  const resource_directories = declared_resources.map((directory, index) => ({
    source_directory: file_directory(
      directory.source_directory,
      app_directory,
      `resource_directories[${index}].source_directory`,
    ),
    public_directory: file_directory(
      directory.public_directory,
      app_directory,
      `resource_directories[${index}].public_directory`,
    ),
  }));
  for (const [index, directory] of resource_directories.entries()) {
    if (!directory_contains(public_directory, directory.public_directory)) {
      throw new Error(
        `Ink Vite resource_directories[${index}].public_directory ${
          JSON.stringify(directory.public_directory.href)
        } must be inside public_directory ${
          JSON.stringify(public_directory.href)
        }`,
      );
    }
  }
  const declared_build = game.build ?? {
    command: "deno",
    arguments: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run=deno",
      "ink.ts",
    ],
  };
  if (
    typeof declared_build.command !== "string" ||
    declared_build.command.trim().length === 0
  ) {
    throw new Error(
      `Ink Vite build.command ${
        JSON.stringify(declared_build.command)
      } must be a non-empty string`,
    );
  }
  if (
    !Array.isArray(declared_build.arguments) ||
    declared_build.arguments.some((argument) => typeof argument !== "string")
  ) {
    throw new Error("Ink Vite build.arguments must contain only strings");
  }
  const working_directory = file_directory(
    declared_build.working_directory ?? app_directory,
    app_directory,
    "build.working_directory",
  );
  const build = Object.freeze({
    command: declared_build.command,
    arguments: Object.freeze([...declared_build.arguments]),
    working_directory,
  });
  const output_inputs = [
    ["web_directory", web_directory],
    ["public_directory", public_directory],
    ["build.working_directory", working_directory],
    ...source_directories.map((directory, index) =>
      [`source_directories[${index}]`, directory] as const
    ),
    ...resource_directories.map((directory, index) =>
      [
        `resource_directories[${index}].source_directory`,
        directory.source_directory,
      ] as const
    ),
  ] as const;
  if (directory_contains(output_directory, app_directory)) {
    throw new Error(
      `Ink Vite output_directory ${
        JSON.stringify(output_directory.href)
      } must not contain app_directory ${JSON.stringify(app_directory.href)}`,
    );
  }
  for (const [field, input_directory] of output_inputs) {
    if (
      directory_contains(output_directory, input_directory) ||
      field !== "build.working_directory" &&
        directory_contains(input_directory, output_directory)
    ) {
      throw new Error(
        `Ink Vite output_directory ${
          JSON.stringify(output_directory.href)
        } must not overlap ${field} ${JSON.stringify(input_directory.href)}`,
      );
    }
  }
  const artifact_name = game.adapter.artifact_name;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(artifact_name)) {
    throw new Error(
      `Ink Vite adapter.artifact_name ${
        JSON.stringify(artifact_name)
      } must be a file name`,
    );
  }
  const browser_module = file_reference(
    game.adapter.browser_module,
    app_directory,
    "adapter.browser_module",
  );
  const browser_factory = game.adapter.browser_factory;
  if (!browser_factory) {
    throw new Error("Ink Vite adapter.browser_factory must not be empty");
  }
  const editor = game.editor === undefined ? undefined : {
    browser_module: file_reference(
      game.editor.browser_module,
      app_directory,
      "editor.browser_module",
    ),
    browser_export: game.editor.browser_export,
  };
  if (editor && editor.browser_export.trim() === "") {
    throw new Error("Ink Vite editor.browser_export must not be empty");
  }
  let adapter_configuration: string | undefined;
  try {
    adapter_configuration = JSON.stringify(
      game.adapter.configuration,
      (key, value: unknown) => {
        if (typeof value === "number" && !Number.isFinite(value)) {
          throw new Error(
            `property ${JSON.stringify(key)} contains non-finite number ${
              String(value)
            }`,
          );
        }
        if (
          value === undefined || typeof value === "bigint" ||
          typeof value === "function" || typeof value === "symbol"
        ) {
          throw new Error(
            `property ${
              JSON.stringify(key)
            } contains unsupported ${typeof value}`,
          );
        }
        return value;
      },
    );
  } catch (cause) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    throw new Error(
      `Ink Vite adapter.configuration must be JSON serializable${detail}`,
      {
        cause,
      },
    );
  }
  if (adapter_configuration === undefined) {
    throw new Error(
      `Ink Vite adapter.configuration ${
        String(game.adapter.configuration)
      } must be JSON serializable`,
    );
  }
  let development_configuration: string | undefined;
  try {
    development_configuration = JSON.stringify(
      game.development ?? {},
      (key, value: unknown) => {
        if (typeof value === "number" && !Number.isFinite(value)) {
          throw new Error(
            `property ${JSON.stringify(key)} contains non-finite number ${
              String(value)
            }`,
          );
        }
        if (
          value === undefined || typeof value === "bigint" ||
          typeof value === "function" || typeof value === "symbol"
        ) {
          throw new Error(
            `property ${
              JSON.stringify(key)
            } contains unsupported ${typeof value}`,
          );
        }
        return value;
      },
    );
  } catch (cause) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    throw new Error(
      `Ink Vite development must be JSON serializable${detail}`,
      { cause },
    );
  }
  if (development_configuration === undefined) {
    throw new Error("Ink Vite development must be JSON serializable");
  }

  return async ({ command }) => {
    const [{ default: babel }, { default: tailwindcss }, react_module] =
      await Promise.all([
        import("@rolldown/plugin-babel"),
        import("@tailwindcss/vite"),
        import("@vitejs/plugin-react"),
      ]);
    return {
      root: fileURLToPath(web_directory),
      define: command === "build"
        ? { "process.env.NODE_ENV": JSON.stringify("production") }
        : undefined,
      plugins: [
        browser_shell(
          artifact_name,
          browser_module,
          browser_factory,
          adapter_configuration,
          development_configuration,
          editor,
        ),
        ink({
          source_directories,
          resource_directories,
          public_directory,
          build: {
            command: build.command,
            arguments: build.arguments,
            working_directory: build.working_directory,
          },
        }),
        react_module.default(),
        babel({ presets: [react_module.reactCompilerPreset()] }),
        tailwindcss(),
      ],
      server: { open: false },
      build: {
        emptyOutDir: true,
        minify: "oxc",
        outDir: fileURLToPath(output_directory),
      },
    };
  };
}

const browser_module_id = "virtual:ink-game-browser";
const resolved_browser_module_id = `\0${browser_module_id}`;

function browser_shell(
  artifact_name: string,
  browser_module: URL,
  browser_factory: string,
  adapter_configuration: string,
  development_configuration: string,
  editor: {
    readonly browser_module: URL;
    readonly browser_export: string;
  } | undefined,
): Plugin {
  return {
    name: "ink-browser-shell",
    resolveId(source) {
      if (source === browser_module_id) return resolved_browser_module_id;
    },
    load(id) {
      if (id !== resolved_browser_module_id) return;
      const module_path = JSON.stringify(fileURLToPath(browser_module));
      const factory_name = JSON.stringify(browser_factory);
      const wasm_url = JSON.stringify(`/${artifact_name}.wasm`);
      const manifest_url = JSON.stringify(`/${artifact_name}.wasm.json`);
      const editor_import = editor
        ? `import * as game_editor from ${
          JSON.stringify(fileURLToPath(editor.browser_module))
        };`
        : "";
      const editor_export = editor
        ? JSON.stringify(editor.browser_export)
        : undefined;
      const editor_setup = editor
        ? `const render_editor = game_editor[${editor_export}];
if (typeof render_editor !== "function") {
  throw new Error("game editor export " + ${editor_export} + " is not a function");
}`
        : "const render_editor = undefined;";
      return `
import { mount_game_development } from "@ink/development/mount_game_development.tsx";
import { game_development_path, resolve_game_development_view } from "@ink/development/browser_routes.ts";
import * as game_adapter from ${module_path};
${editor_import}

const create_artifact_loader = game_adapter[${factory_name}];
if (typeof create_artifact_loader !== "function") {
  throw new Error("game adapter export " + ${factory_name} + " is not a function");
}
const load_artifact = create_artifact_loader(${adapter_configuration});
const development = ${development_configuration};
${editor_setup}

const root = document.getElementById("root");
if (!root) throw new Error("game development root element is missing");
const root_view = render_editor === undefined ? "game" : "editor";
const development_view = resolve_game_development_view(location.pathname, root_view);
if (location.pathname === "/") {
  history.replaceState(null, "", game_development_path(development_view));
}

mount_game_development(root, {
  ...development,
  auto_play: development_view === "game" ? development.auto_play : false,
  assets: {
    wasm_url: ${wasm_url},
    manifest_url: ${manifest_url},
  },
  load_artifact,
  render_editor: development_view === "editor" ? render_editor : undefined,
  workspace_channel: ${JSON.stringify(artifact_name)},
});
`;
    },
  };
}

function file_directory(
  reference: DirectoryReference,
  base_directory: URL,
  field: string,
): URL {
  const resolved = typeof reference === "string"
    ? new URL(reference, base_directory)
    : new URL(reference.href);
  if (resolved.protocol !== "file:") {
    throw new Error(
      `Ink Vite ${field} ${JSON.stringify(resolved.href)} must be a file URL`,
    );
  }
  if (resolved.search || resolved.hash) {
    throw new Error(
      `Ink Vite ${field} ${
        JSON.stringify(resolved.href)
      } cannot contain a query or fragment`,
    );
  }
  if (!resolved.pathname.endsWith("/")) resolved.pathname += "/";
  return resolved;
}

function file_reference(
  reference: DirectoryReference,
  base_directory: URL,
  field: string,
): URL {
  const resolved = typeof reference === "string"
    ? new URL(reference, base_directory)
    : new URL(reference.href);
  if (resolved.protocol !== "file:") {
    throw new Error(
      `Ink Vite ${field} ${JSON.stringify(resolved.href)} must be a file URL`,
    );
  }
  if (resolved.search || resolved.hash) {
    throw new Error(
      `Ink Vite ${field} ${
        JSON.stringify(resolved.href)
      } cannot contain a query or fragment`,
    );
  }
  return resolved;
}

function directory_contains(parent: URL, candidate: URL): boolean {
  const path = relative(fileURLToPath(parent), fileURLToPath(candidate));
  return path === "" ||
    path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
