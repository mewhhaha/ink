const destination = new URL(
  "../apps/lighting-dev/assets/reference/",
  import.meta.url,
);
const bistro_destination = new URL("BistroExterior.glb", destination);
const caldera_destination = new URL("CalderaHotel.glb", destination);
const force = Deno.args.length === 1 && Deno.args[0] === "--force";
if (!force && Deno.args.length !== 0) {
  throw new Error(
    `usage: deno run scripts/sync_lighting_reference_scenes.ts [--force], received ${
      JSON.stringify(Deno.args)
    }`,
  );
}

await Deno.mkdir(destination, { recursive: true });
const temporary_directory = await Deno.makeTempDir({
  prefix: "ink-lighting-scenes-",
});
try {
  if (force || !(await exists(bistro_destination))) {
    await synchronize_bistro(temporary_directory);
  }
  if (force || !(await exists(caldera_destination))) {
    await synchronize_caldera(temporary_directory);
  }
} finally {
  await Deno.remove(temporary_directory, { recursive: true });
}

console.log(
  `lighting reference scenes are available in ${destination.pathname}`,
);

async function synchronize_bistro(temporary_root: string): Promise<void> {
  const archive = `${temporary_root}/Bistro_v5_2.zip`;
  const source_directory = `${temporary_root}/bistro`;
  const converted = `${temporary_root}/BistroExterior.glb`;
  const response = await fetch("https://developer.nvidia.com/bistro");
  if (!response.ok || response.body === null) {
    throw new Error(
      `NVIDIA Bistro download failed with HTTP ${response.status}`,
    );
  }
  using archive_file = await Deno.open(archive, {
    createNew: true,
    write: true,
  });
  await response.body.pipeTo(archive_file.writable);
  await run("unzip", ["-q", archive, "-d", source_directory]);
  await convert(
    `${source_directory}/Bistro_v5_2/BistroExterior.fbx`,
    converted,
    ["--texture-size", "256"],
  );
  await replace(converted, bistro_destination);
}

async function synchronize_caldera(temporary_root: string): Promise<void> {
  const checkout = `${temporary_root}/caldera`;
  const converted = `${temporary_root}/CalderaHotel.glb`;
  await run("git", [
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    "--depth=1",
    "https://github.com/Activision/caldera.git",
    checkout,
  ]);
  await run("git", [
    "-C",
    checkout,
    "sparse-checkout",
    "init",
    "--cone",
  ]);
  await run("git", [
    "-C",
    checkout,
    "sparse-checkout",
    "set",
    "map_source/prefabs/br/wz_vg/mp_wz_island/commercial/hotel_01.usd",
    "map_source/prefabs/br/wz_vg/mp_wz_island/commercial/hotel_01",
  ]);
  await run("git", ["-C", checkout, "checkout", "HEAD"]);
  await convert(
    `${checkout}/map_source/prefabs/br/wz_vg/mp_wz_island/commercial/hotel_01.usd`,
    converted,
    [],
  );
  await replace(converted, caldera_destination);
}

async function convert(
  source: string,
  output: string,
  options: readonly string[],
): Promise<void> {
  await run("blender", [
    "--background",
    "--python",
    new URL("./convert_reference_scene.py", import.meta.url).pathname,
    "--",
    source,
    output,
    ...options,
  ]);
}

async function replace(source: string, target: URL): Promise<void> {
  const pending = new URL(`${target.pathname}.pending`, target);
  await Deno.copyFile(source, pending);
  await Deno.rename(pending, target);
}

async function exists(path: URL): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function run(
  command: string,
  arguments_: readonly string[],
): Promise<void> {
  const result = await new Deno.Command(command, {
    args: [...arguments_],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) {
    throw new Error(
      `${command} ${arguments_.join(" ")} exited with ${result.code}`,
    );
  }
}
