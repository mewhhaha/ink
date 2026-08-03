const app_directory = new URL("./", import.meta.url);
const blot_directory = new URL("../../../blot/", import.meta.url);
const game_source = new URL("blot/game/main.blot", app_directory);
const game_wasm = new URL("blot/game/main.wasm", app_directory);
const game_manifest = new URL("blot/game/main.wasm.json", app_directory);
const assets_directory = new URL("assets/", app_directory);
const generated_directory = new URL("generated/", app_directory);
const generated_assets_directory = new URL("assets/", generated_directory);
const build_lock_path = new URL(".ink-build.lock", generated_directory);
const generated_wasm = new URL("isometric_city.wasm", generated_directory);
const generated_manifest = new URL(
  "isometric_city.wasm.json",
  generated_directory,
);
const pending_wasm = new URL(
  `.isometric_city.wasm.${Deno.pid}.pending`,
  generated_directory,
);
const pending_manifest = new URL(
  `.isometric_city.wasm.json.${Deno.pid}.pending`,
  generated_directory,
);

await Deno.mkdir(generated_directory, { recursive: true });
const build_lock = await Deno.open(build_lock_path, {
  create: true,
  write: true,
});
await build_lock.lock(true);
try {
  const build = new Deno.Command(Deno.execPath(), {
    cwd: app_directory,
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      new URL("src/cli.ts", blot_directory).pathname,
      "build",
      game_source.pathname,
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
  const built = await build.output();
  if (!built.success) {
    throw new Error(`Blot build exited with code ${built.code}`);
  }

  await remove_if_present(generated_assets_directory, { recursive: true });
  await Deno.mkdir(generated_assets_directory, { recursive: true });
  for await (const entry of Deno.readDir(assets_directory)) {
    if (!entry.isFile) {
      throw new Error(`game asset ${JSON.stringify(entry.name)} is not a file`);
    }
    await Deno.copyFile(
      new URL(entry.name, assets_directory),
      new URL(entry.name, generated_assets_directory),
    );
  }

  await Promise.all([
    Deno.copyFile(game_wasm, pending_wasm),
    Deno.copyFile(game_manifest, pending_manifest),
  ]);
  await Promise.all([
    Deno.rename(pending_wasm, generated_wasm),
    Deno.rename(pending_manifest, generated_manifest),
  ]);
} finally {
  try {
    await Promise.all([
      remove_if_present(game_wasm),
      remove_if_present(game_manifest),
      remove_if_present(pending_wasm),
      remove_if_present(pending_manifest),
    ]);
  } finally {
    await build_lock.unlock();
    build_lock.close();
  }
}

async function remove_if_present(
  path: URL,
  options?: Deno.RemoveOptions,
): Promise<void> {
  try {
    await Deno.remove(path, options);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
