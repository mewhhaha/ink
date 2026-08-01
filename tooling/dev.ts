const project_directory = new URL("../", import.meta.url);
const vite_origin = "http://127.0.0.1:5173";

await run_task("build:game");

const vite = new Deno.Command(Deno.execPath(), {
  cwd: project_directory,
  args: [
    "run",
    "-A",
    "npm:vite@8.2.0",
    "--host",
    "127.0.0.1",
    "--port",
    "5173",
    "--strictPort",
  ],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
let vite_running = true;
const vite_status = vite.status.then((status) => {
  vite_running = false;
  return status;
});

await wait_for_vite();

const desktop = new Deno.Command(Deno.execPath(), {
  cwd: project_directory,
  args: [
    "desktop",
    "--backend",
    "cef",
    "--hmr",
    "--allow-net",
    "--allow-read",
    "--include",
    "public",
    "main.ts",
    `--editor-vite-origin=${vite_origin}`,
  ],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
let desktop_running = true;
const desktop_status = desktop.status.then((status) => {
  desktop_running = false;
  return status;
});

const watcher = Deno.watchFs([
  new URL("../blocks/blot/", import.meta.url).pathname,
  new URL("../games/scene_explorer/main.blot", import.meta.url).pathname,
]);
let rebuilding = false;
let rebuild_again = false;

try {
  const stopped = await Promise.race([
    vite_status.then((status) => ({ source: "Vite", status } as const)),
    desktop_status.then((
      status,
    ) => ({ source: "Deno Desktop", status } as const)),
    watch_game_sources().then(
      () => ({ source: "game source watcher" } as const),
    ),
  ]);
  if ("status" in stopped && !stopped.status.success) {
    throw new Error(
      `${stopped.source} exited with code ${stopped.status.code}`,
    );
  }
} finally {
  watcher.close();
  if (desktop_running) desktop.kill("SIGTERM");
  if (vite_running) vite.kill("SIGTERM");
}

async function watch_game_sources(): Promise<void> {
  for await (const event of watcher) {
    if (event.kind === "access") continue;
    if (rebuilding) {
      rebuild_again = true;
      continue;
    }

    do {
      rebuilding = true;
      rebuild_again = false;
      try {
        await run_task("build:game");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      } finally {
        rebuilding = false;
      }
    } while (rebuild_again);
  }
}

async function run_task(task: string): Promise<void> {
  const command = new Deno.Command(Deno.execPath(), {
    cwd: project_directory,
    args: ["task", task],
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await command.output();
  if (!status.success) {
    throw new Error(`deno task ${task} exited with code ${status.code}`);
  }
}

async function wait_for_vite(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!vite_running) {
      const status = await vite_status;
      throw new Error(`Vite exited with code ${status.code} before starting`);
    }

    try {
      const response = await fetch(`${vite_origin}/@vite/client`);
      if (response.ok) return;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Vite did not start at ${vite_origin}`);
}
