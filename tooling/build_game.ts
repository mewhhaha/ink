const project_directory = new URL("../", import.meta.url);
const blot_directory = new URL("../../blot/", import.meta.url);
const game_source = new URL(
  "games/scene_explorer/main.blot",
  project_directory,
);
const game_wasm = new URL("games/scene_explorer/main.wasm", project_directory);
const game_manifest = new URL(
  "games/scene_explorer/main.wasm.json",
  project_directory,
);
const beacon_model = new URL("assets/models/beacon.obj", project_directory);
const generated_directory = new URL("generated/", project_directory);
const public_directory = new URL("public/", project_directory);

const check = new Deno.Command(Deno.execPath(), {
  cwd: blot_directory,
  args: [
    "task",
    "blot",
    "check",
    new URL("blocks/blot/math.blot", project_directory).pathname,
    new URL("blocks/blot/flex.blot", project_directory).pathname,
    new URL("blocks/blot/geometry.blot", project_directory).pathname,
    new URL("blocks/blot/sprite.blot", project_directory).pathname,
    new URL("blocks/blot/tilemap.blot", project_directory).pathname,
    game_source.pathname,
  ],
  stdout: "inherit",
  stderr: "inherit",
});
const checked = await check.output();
if (!checked.success) {
  throw new Error(`Blot checks exited with code ${checked.code}`);
}

const build = new Deno.Command(Deno.execPath(), {
  cwd: project_directory,
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
  env: { WGPU_BACKENDS: Deno.env.get("WGPU_BACKENDS") ?? "vulkan" },
});
const built = await build.output();
if (!built.success) {
  throw new Error(`Blot build exited with code ${built.code}`);
}

await Deno.mkdir(generated_directory, { recursive: true });
await Deno.mkdir(public_directory, { recursive: true });
await Promise.all([
  Deno.copyFile(game_wasm, new URL("scene_explorer.wasm", generated_directory)),
  Deno.copyFile(
    game_manifest,
    new URL("scene_explorer.wasm.json", generated_directory),
  ),
  Deno.copyFile(beacon_model, new URL("beacon.obj", generated_directory)),
  Deno.copyFile(game_wasm, new URL("scene_explorer.wasm", public_directory)),
  Deno.copyFile(
    game_manifest,
    new URL("scene_explorer.wasm.json", public_directory),
  ),
  Deno.copyFile(beacon_model, new URL("beacon.obj", public_directory)),
]);
