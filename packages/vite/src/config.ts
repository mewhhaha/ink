import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { UserConfigFn } from "vite";
import { ink_application, type InkApplicationBuild } from "./plugin.ts";

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

export interface InkViteApplication {
  readonly app_directory: URL;
  readonly source_directories: readonly DirectoryReference[];
  readonly resource_directories?: readonly InkViteResourceDirectory[];
  readonly public_directory?: DirectoryReference;
  readonly web_directory?: DirectoryReference;
  readonly output_directory?: DirectoryReference;
  readonly build?: InkViteBuildCommand;
  readonly development_build?: InkApplicationBuild;
}

export function define_ink_application(
  application: InkViteApplication,
): UserConfigFn {
  const app_directory = file_directory(
    application.app_directory,
    application.app_directory,
    "app_directory",
  );
  const public_directory = file_directory(
    application.public_directory ?? "generated/",
    app_directory,
    "public_directory",
  );
  const web_directory = file_directory(
    application.web_directory ?? app_directory,
    app_directory,
    "web_directory",
  );
  const output_directory = file_directory(
    application.output_directory ?? "dist/",
    app_directory,
    "output_directory",
  );
  const source_directories = application.source_directories.map(
    (directory, index) =>
      file_directory(
        directory,
        app_directory,
        `source_directories[${index}]`,
      ),
  );
  const declared_resources = application.resource_directories ?? [{
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
    if (directory_contains(public_directory, directory.public_directory)) {
      continue;
    }
    throw new Error(
      `Ink Vite resource_directories[${index}].public_directory ${
        JSON.stringify(directory.public_directory.href)
      } must be inside public_directory ${
        JSON.stringify(public_directory.href)
      }`,
    );
  }

  const declared_build = application.build ?? {
    command: "deno",
    arguments: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run=deno",
      "ink.ts",
    ],
  };
  const command = declared_build.command.trim();
  if (command.length === 0) {
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

  validate_output_directory(
    output_directory,
    app_directory,
    web_directory,
    public_directory,
    working_directory,
    source_directories,
    resource_directories,
  );

  return ({ command: vite_command }) => ({
    root: fileURLToPath(web_directory),
    define: vite_command === "build"
      ? { "process.env.NODE_ENV": JSON.stringify("production") }
      : undefined,
    plugins: [ink_application({
      source_directories,
      resource_directories,
      public_directory,
      build: vite_command === "serve" && application.development_build
        ? application.development_build
        : {
          command,
          arguments: Object.freeze([...declared_build.arguments]),
          working_directory,
        },
    })],
    server: { open: false },
    build: {
      emptyOutDir: true,
      minify: "oxc",
      outDir: fileURLToPath(output_directory),
    },
  });
}

function validate_output_directory(
  output_directory: URL,
  app_directory: URL,
  web_directory: URL,
  public_directory: URL,
  working_directory: URL,
  source_directories: readonly URL[],
  resource_directories: readonly {
    readonly source_directory: URL;
  }[],
): void {
  if (directory_contains(output_directory, app_directory)) {
    throw new Error(
      `Ink Vite output_directory ${
        JSON.stringify(output_directory.href)
      } must not contain app_directory ${JSON.stringify(app_directory.href)}`,
    );
  }
  const inputs = [
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
  for (const [field, input_directory] of inputs) {
    const output_contains_input = directory_contains(
      output_directory,
      input_directory,
    );
    const input_contains_output = field !== "build.working_directory" &&
      field !== "web_directory" &&
      directory_contains(input_directory, output_directory);
    if (!output_contains_input && !input_contains_output) continue;
    throw new Error(
      `Ink Vite output_directory ${
        JSON.stringify(output_directory.href)
      } must not overlap ${field} ${JSON.stringify(input_directory.href)}`,
    );
  }
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

function directory_contains(parent: URL, candidate: URL): boolean {
  const path = relative(fileURLToPath(parent), fileURLToPath(candidate));
  return path === "" ||
    path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
