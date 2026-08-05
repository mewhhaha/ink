import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { game_updated_event } from "./hot_reload.ts";

interface ProcessCommand {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly working_directory: URL;
}

export interface InkGameDevelopment {
  readonly source_directories: readonly URL[];
  readonly resource_directories: readonly {
    readonly source_directory: URL;
    readonly public_directory: URL;
  }[];
  readonly public_directory: URL;
  readonly build: ProcessCommand;
}

export function ink(game: InkGameDevelopment): Plugin {
  const source_directories = game.source_directories.map((directory) =>
    fileURLToPath(directory)
  );
  const resource_directories = game.resource_directories.map((directory) => ({
    source_directory: fileURLToPath(directory.source_directory),
    public_directory: fileURLToPath(directory.public_directory),
  }));
  const public_directory = fileURLToPath(game.public_directory);
  let game_build = Promise.resolve();

  const build_latest_game = async () => {
    await build_game(game);
  };

  const compile_game = () => {
    game_build = game_build.then(build_latest_game, build_latest_game);
    return game_build;
  };

  return {
    name: "ink-game-development",
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
        public_directory,
      ]);
    },
    async hotUpdate({ file }) {
      const blot_changed = file.endsWith(".blot") &&
        source_directories.some((directory) => file.startsWith(directory));
      const resource_directory = resource_directories.find((directory) =>
        file.startsWith(directory.source_directory)
      );
      const generated_asset_changed = file.startsWith(public_directory) &&
        !file.endsWith(".tmp");
      if (!blot_changed && !resource_directory && !generated_asset_changed) {
        return;
      }
      if (this.environment.name !== "client") return [];

      try {
        if (resource_directory) {
          await copy_changed_resource(file, resource_directory);
        } else if (blot_changed) {
          await compile_game();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.environment.hot.send(game_updated_event, {
          type: resource_directory ? "resource_error" : "compilation_error",
          message,
        });
        return [];
      }
      const generated_game_asset = file.endsWith(".wasm") ||
        file.endsWith(".manifest.json");
      this.environment.hot.send(game_updated_event, {
        type: resource_directory ||
            (generated_asset_changed && !generated_game_asset)
          ? "resources"
          : "game",
      });
      return [];
    },
  };
}

async function copy_changed_resource(
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
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(file, destination);
}

async function build_game(game: InkGameDevelopment): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const build = spawn(game.build.command, [...game.build.arguments], {
      cwd: fileURLToPath(game.build.working_directory),
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
