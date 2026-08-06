import { ink } from "@ink/development/vite.ts";
import { fileURLToPath } from "node:url";
import type { UserConfigFnPromise } from "vite";

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

export interface InkViteGame {
  readonly app_directory: URL;
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
    game.web_directory ?? app_directory,
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
  const build = game.build ?? {
    command: "deno",
    arguments: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run=deno",
      "ink.ts",
    ],
  };
  const working_directory = file_directory(
    build.working_directory ?? app_directory,
    app_directory,
    "build.working_directory",
  );

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
        ink({
          source_directories,
          resource_directories,
          public_directory,
          build: {
            command: build.command,
            arguments: build.arguments,
            working_directory,
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
