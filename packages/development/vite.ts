import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Plugin, ResolvedConfig } from "vite";
import { game_updated_event } from "./hot_reload.ts";

interface ProcessCommand {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly working_directory: URL;
}

export interface InkGameDevelopment {
  readonly source_directories: readonly URL[];
  readonly public_directory: URL;
  readonly build: ProcessCommand;
  readonly compiler_service: ProcessCommand & {
    readonly url_environment: string;
  };
}

interface CompilerService {
  readonly url: string;
  stop(): Promise<void>;
}

const compiler_service_ready = "Blot compiler service listening at ";

export function ink(game: InkGameDevelopment): Plugin {
  const source_directories = game.source_directories.map((directory) =>
    fileURLToPath(directory)
  );
  const public_directory = fileURLToPath(game.public_directory);
  let game_build = Promise.resolve();
  let development = false;
  let compiler_service: Promise<CompilerService> | undefined;

  const start_development_compiler = () => {
    compiler_service ??= start_compiler_service(game.compiler_service);
    return compiler_service;
  };

  const build_latest_game = async () => {
    const service_url = development
      ? (await start_development_compiler()).url
      : undefined;
    await build_game(game, service_url);
  };

  const compile_game = () => {
    game_build = game_build.then(build_latest_game, build_latest_game);
    return game_build;
  };

  const stop_development_compiler = async () => {
    const running_service = compiler_service;
    compiler_service = undefined;
    if (running_service === undefined) return;
    const service = await running_service;
    await service.stop();
  };

  return {
    name: "ink-game-development",
    config() {
      return {
        publicDir: public_directory,
        server: {
          watch: {
            ignored: (path) => path.startsWith(public_directory),
          },
        },
      };
    },
    configResolved(config: ResolvedConfig) {
      development = config.command === "serve";
    },
    async buildStart() {
      await compile_game();
    },
    configureServer(server) {
      server.watcher.add(source_directories);
      server.httpServer?.once("close", () => {
        void stop_development_compiler().catch((error) => {
          const message = error instanceof Error
            ? error.message
            : String(error);
          server.config.logger.error(
            `could not stop the Blot compiler service: ${message}`,
          );
        });
      });
    },
    async hotUpdate({ file }) {
      if (!file.endsWith(".blot")) return;
      if (
        !source_directories.some((directory) => file.startsWith(directory))
      ) return;
      if (this.environment.name !== "client") return [];

      await compile_game();
      this.environment.hot.send(game_updated_event);
      return [];
    },
    async closeBundle() {
      await stop_development_compiler();
    },
  };
}

async function build_game(
  game: InkGameDevelopment,
  compiler_service_url: string | undefined,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const environment = compiler_service_url === undefined ? process.env : {
      ...process.env,
      [game.compiler_service.url_environment]: compiler_service_url,
    };
    const build = spawn(game.build.command, [...game.build.arguments], {
      cwd: fileURLToPath(game.build.working_directory),
      env: environment,
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

async function start_compiler_service(
  command: InkGameDevelopment["compiler_service"],
): Promise<CompilerService> {
  const compiler = spawn(command.command, [...command.arguments], {
    cwd: fileURLToPath(command.working_directory),
    stdio: ["ignore", "pipe", "inherit"],
  });
  const output = compiler.stdout;
  if (output === null) {
    compiler.kill();
    throw new Error("Blot compiler service did not expose stdout");
  }

  const lines = createInterface({ input: output });
  const url = await new Promise<string>((resolve, reject) => {
    let ready = false;
    compiler.once("error", (cause) => {
      reject(new Error("Blot compiler service could not start", { cause }));
    });
    compiler.once("exit", (code, signal) => {
      if (ready) return;
      reject(
        new Error(
          signal
            ? `Blot compiler service stopped after ${signal} before becoming ready`
            : `Blot compiler service exited with code ${code} before becoming ready`,
        ),
      );
    });
    lines.on("line", (line) => {
      console.log(line);
      if (ready || !line.startsWith(compiler_service_ready)) return;
      const announced_url = line.slice(compiler_service_ready.length);
      let parsed_url: URL;
      try {
        parsed_url = new URL(announced_url);
      } catch (cause) {
        reject(
          new Error(
            `Blot compiler service announced invalid URL ${
              JSON.stringify(announced_url)
            }`,
            { cause },
          ),
        );
        compiler.kill();
        return;
      }
      ready = true;
      resolve(parsed_url.href);
    });
  });

  return {
    url,
    async stop() {
      if (compiler.exitCode !== null || compiler.signalCode !== null) return;
      await new Promise<void>((resolve, reject) => {
        compiler.once("exit", () => resolve());
        compiler.once("error", (cause) => {
          reject(new Error("Blot compiler service could not stop", { cause }));
        });
        if (compiler.kill()) return;
        if (compiler.exitCode !== null || compiler.signalCode !== null) {
          resolve();
          return;
        }
        reject(
          new Error(
            `Blot compiler service process ${
              compiler.pid ?? "without a pid"
            } rejected termination`,
          ),
        );
      });
    },
  };
}
