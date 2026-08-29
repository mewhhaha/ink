import { spawn } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { application_updated_event } from "./client.ts";

interface ProcessCommand {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly working_directory: URL;
}

export interface InkApplicationDevelopment {
  readonly source_directories: readonly URL[];
  readonly resource_directories: readonly {
    readonly source_directory: URL;
    readonly public_directory: URL;
  }[];
  readonly public_directory: URL;
  readonly build: ProcessCommand;
}

export function ink_application(game: InkApplicationDevelopment): Plugin {
  if (
    typeof game.build.command !== "string" ||
    game.build.command.trim().length === 0
  ) {
    throw new Error("Ink application build command cannot be empty");
  }
  if (
    !Array.isArray(game.source_directories) ||
    !Array.isArray(game.resource_directories) ||
    !Array.isArray(game.build.arguments) ||
    game.build.arguments.some((argument) => typeof argument !== "string")
  ) {
    throw new Error(
      "Ink source directories, resource directories, and build arguments must be arrays with string arguments",
    );
  }
  const source_directories = game.source_directories.map((directory) =>
    fileURLToPath(directory)
  );
  const resource_directories = game.resource_directories.map((directory) => ({
    source_directory: fileURLToPath(directory.source_directory),
    public_directory: fileURLToPath(directory.public_directory),
  }));
  const public_directory = fileURLToPath(game.public_directory);
  const build = Object.freeze({
    command: game.build.command.trim(),
    arguments: Object.freeze([...game.build.arguments]),
    working_directory: new URL(game.build.working_directory.href),
  });
  let requested_build = 0;
  let completed_build = 0;
  let active_build: Promise<number> | undefined;
  let notified_build = 0;

  const compile_game = (): Promise<number> => {
    requested_build += 1;
    active_build ??= build_requested_games().finally(() => {
      active_build = undefined;
    });
    return active_build;
  };

  const build_requested_games = async (): Promise<number> => {
    while (completed_build < requested_build) {
      const current_build = requested_build;
      await build_game(build);
      completed_build = current_build;
    }
    return completed_build;
  };

  return {
    name: "ink-application-development",
    config() {
      return { publicDir: public_directory };
    },
    async buildStart() {
      await compile_game();
    },
    configureServer(server) {
      server.watcher.add([
        ...source_directories,
        ...resource_directories.map((directory) => directory.source_directory),
      ]);
    },
    async hotUpdate({ file, type }) {
      const source_changed = !compiler_generated_file(file) &&
        source_directories.some((directory) => path_is_within(directory, file));
      const resource_directory = resource_directories.find((directory) =>
        path_is_within(directory.source_directory, file)
      );
      if (!source_changed && !resource_directory) return;
      if (this.environment.name !== "client") return [];

      try {
        if (resource_directory) {
          await synchronize_changed_resource(type, file, resource_directory);
        } else {
          const build = await compile_game();
          if (build <= notified_build) return [];
          notified_build = build;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.environment.hot.send(application_updated_event, {
          type: resource_directory ? "resource_error" : "compilation_error",
          message,
        });
        return [];
      }
      this.environment.hot.send(application_updated_event, {
        type: resource_directory ? "resources" : "game",
      });
      return [];
    },
  };
}

function path_is_within(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) &&
    !isAbsolute(path);
}

function compiler_generated_file(file: string): boolean {
  return file.endsWith(".wasm") || file.endsWith(".wasm.json") ||
    file.endsWith(".pending") || file.endsWith(".tmp");
}

async function synchronize_changed_resource(
  type: "create" | "update" | "delete",
  file: string,
  directory: {
    readonly source_directory: string;
    readonly public_directory: string;
  },
): Promise<void> {
  const resource_path = relative(directory.source_directory, file);
  if (resource_path.startsWith("..")) {
    throw new Error(
      `resource ${JSON.stringify(file)} is outside ${
        JSON.stringify(directory.source_directory)
      }`,
    );
  }
  const destination = resolve(directory.public_directory, resource_path);
  if (type === "delete") {
    await rm(destination, { force: true });
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(file, destination);
}

async function build_game(build_command: ProcessCommand): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const build = spawn(build_command.command, [...build_command.arguments], {
      cwd: fileURLToPath(build_command.working_directory),
      stdio: "inherit",
    });
    build.on("error", (cause) => {
      reject(new Error("game compiler could not start", { cause }));
    });
    build.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `game compiler stopped after ${signal}`
            : `game compiler exited with code ${code}`,
        ),
      );
    });
  });
}
