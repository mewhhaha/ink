const app_directory = new URL("./", import.meta.url);
const blot_directory = new URL("../../../blot/", import.meta.url);
const game_source = new URL("blot/game/main.blot", app_directory);
const game_wasm = new URL("blot/game/main.wasm", app_directory);
const game_manifest = new URL("blot/game/main.wasm.json", app_directory);
const generated_directory = new URL("generated/", app_directory);
const compiler_service_url = Deno.env.get("BLOT_COMPILER_URL");
const compiler_mode = compiler_service_url === undefined
  ? []
  : ["--mode=service", `--service-url=${compiler_service_url}`];
const compiler_network = compiler_service_url === undefined
  ? []
  : ["--allow-net=127.0.0.1"];

const build = new Deno.Command(Deno.execPath(), {
  cwd: app_directory,
  args: [
    "run",
    "--allow-read",
    "--allow-write",
    ...compiler_network,
    new URL("src/cli.ts", blot_directory).pathname,
    "build",
    ...compiler_mode,
    game_source.pathname,
  ],
  stdout: "inherit",
  stderr: "inherit",
  env: { WGPU_BACKENDS: Deno.env.get("WGPU_BACKENDS") ?? "vulkan" },
});
const built = await build.output();
if (!built.success) {
  throw new Error(`Blot build exited with code ${built.code}`);
}

await Deno.mkdir(generated_directory, { recursive: true });
await Promise.all([
  Deno.copyFile(game_wasm, new URL("isometric_city.wasm", generated_directory)),
  Deno.copyFile(
    game_manifest,
    new URL("isometric_city.wasm.json", generated_directory),
  ),
  Deno.copyFile(
    new URL("assets/terrain.obj", app_directory),
    new URL("terrain.obj", generated_directory),
  ),
]);
await Promise.all([Deno.remove(game_wasm), Deno.remove(game_manifest)]);
