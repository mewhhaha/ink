const destination = new URL(
  "../apps/lighting-dev/assets/reference/",
  import.meta.url,
);
const bistro_destination = new URL("BistroExterior.glb", destination);
const caldera_destination = new URL("CalderaHotel.glb", destination);
const caldera_revision = "03feaa1886c0a39bc50ca0df86c321f74ed4eee6";
const caldera_source_note = `# Caldera hotel reference

\`CalderaHotel.glb\` is converted from Activision's Caldera data set at
revision \`${caldera_revision}\`.

The upstream release explicitly excludes textures and materials. Ink retains
the actual hotel geometry graph and its authored geometry attributes. It does
not generate replacement textures or claim texture fidelity that the source
does not provide.

The sync tool resolves the hotel's recursive USD dependency closure and runs
\`usdchecker\` before Blender conversion. Missing referenced geometry stops the
conversion with the unresolved path.

https://github.com/Activision/caldera/tree/${caldera_revision}/map_source/prefabs/br/wz_vg/mp_wz_island/commercial/hotel_01
`;
if (import.meta.main) await synchronize_lighting_reference_scenes();

async function synchronize_lighting_reference_scenes(): Promise<void> {
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
}

async function synchronize_bistro(temporary_root: string): Promise<void> {
  const archive = `${temporary_root}/Bistro_v5_2.zip`;
  const source_directory = `${temporary_root}/bistro`;
  const converted = `${temporary_root}/BistroExterior.glb`;
  const report = `${temporary_root}/BistroExterior.report.json`;
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
    ["--texture-size", "256", "--report", report],
  );
  await validate_conversion_report(report, "bistro", {
    expected_materials: "present",
    expected_images: "present",
  });
  await replace(converted, bistro_destination);
}

async function synchronize_caldera(temporary_root: string): Promise<void> {
  const checkout = `${temporary_root}/caldera`;
  const converted = `${temporary_root}/CalderaHotel.glb`;
  const report = `${temporary_root}/CalderaHotel.report.json`;
  const source_relative =
    "map_source/prefabs/br/wz_vg/mp_wz_island/commercial/hotel_01.usd";
  await Deno.mkdir(checkout);
  await run("git", ["-C", checkout, "init"]);
  await run("git", [
    "-C",
    checkout,
    "remote",
    "add",
    "origin",
    "https://github.com/Activision/caldera.git",
  ]);
  await run("git", [
    "-C",
    checkout,
    "fetch",
    "--depth=1",
    "--filter=blob:none",
    "origin",
    caldera_revision,
  ]);
  await run("git", [
    "-C",
    checkout,
    "sparse-checkout",
    "init",
    "--no-cone",
  ]);
  const sparse_paths = new Set([
    "/README.md",
    "/LICENSE.md",
    `/${source_relative}`,
    "/map_source/prefabs/br/wz_vg/mp_wz_island/commercial/hotel_01/",
  ]);
  await set_sparse_paths(checkout, sparse_paths);
  await run("git", ["-C", checkout, "checkout", caldera_revision]);
  const upstream_readme = await Deno.readTextFile(`${checkout}/README.md`);
  if (
    !upstream_readme.includes(
      "chosen not to include textures and materials in this release",
    )
  ) {
    throw new Error(
      `Caldera revision ${caldera_revision} no longer documents the expected material omission`,
    );
  }
  await include_usd_dependency_closure(
    checkout,
    `${checkout}/${source_relative}`,
    sparse_paths,
    `${temporary_root}/CalderaHotel.usdcheck.txt`,
  );
  await convert(
    `${checkout}/${source_relative}`,
    converted,
    ["--report", report],
  );
  await validate_conversion_report(report, "caldera", {
    expected_materials: "absent",
    expected_images: "absent",
  });
  await replace(converted, caldera_destination);
  await Deno.writeTextFile(
    new URL("CALDERA_SOURCE.md", destination),
    caldera_source_note,
  );
}

export async function include_usd_dependency_closure(
  checkout: string,
  source: string,
  sparse_paths: Set<string>,
  validation_report: string,
): Promise<void> {
  for (let pass = 1; pass <= 12; pass += 1) {
    const result = await new Deno.Command("usdchecker", {
      args: ["-s", "-o", validation_report, source],
      stdout: "null",
      stderr: "null",
    }).output();
    const report = await Deno.readTextFile(validation_report);
    const missing = missing_usd_dependencies(report, checkout);
    if (missing.length === 0) {
      if (!result.success) {
        const evidence = report.split("\n").slice(0, 8).join("\n");
        throw new Error(
          `Caldera USD validation failed after resolving ${sparse_paths.size} source paths:\n${evidence}`,
        );
      }
      console.log(
        `Caldera USD dependency closure contains ${sparse_paths.size} source paths`,
      );
      return;
    }
    let added = 0;
    for (const path of missing) {
      const sparse_path = `/${path}`;
      if (sparse_paths.has(sparse_path)) continue;
      sparse_paths.add(sparse_path);
      added += 1;
    }
    if (added === 0) {
      throw new Error(
        `Caldera USD dependency pass ${pass} still cannot resolve ${missing.length} checked-out assets; first missing asset is ${
          JSON.stringify(missing[0])
        }`,
      );
    }
    await set_sparse_paths(checkout, sparse_paths);
  }
  throw new Error(
    `Caldera USD dependencies did not converge after 12 passes; ${sparse_paths.size} source paths were included`,
  );
}

function missing_usd_dependencies(
  report: string,
  checkout: string,
): readonly string[] {
  const prefix = `${checkout}/`;
  const paths = new Set<string>();
  const patterns = [
    /Could not open asset @([^@]+\.usd)@/g,
    /Found unresolvable external dependency '([^']+\.usd)'/g,
  ];
  for (const pattern of patterns) {
    for (const match of report.matchAll(pattern)) {
      const absolute_path = match[1];
      if (!absolute_path.startsWith(prefix)) {
        throw new Error(
          `Caldera USD validation reported dependency outside its checkout: ${
            JSON.stringify(absolute_path)
          }`,
        );
      }
      paths.add(absolute_path.slice(prefix.length));
    }
  }
  return [...paths].sort();
}

async function set_sparse_paths(
  checkout: string,
  paths: ReadonlySet<string>,
): Promise<void> {
  const command = new Deno.Command("git", {
    args: ["-C", checkout, "sparse-checkout", "set", "--no-cone", "--stdin"],
    stdin: "piped",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const writer = command.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(`${[...paths].sort().join("\n")}\n`),
  );
  await writer.close();
  const status = await command.status;
  if (!status.success) {
    throw new Error(
      `git sparse-checkout set for ${
        JSON.stringify(checkout)
      } exited with ${status.code}`,
    );
  }
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

interface ConversionExpectation {
  readonly expected_images: "absent" | "present";
  readonly expected_materials: "absent" | "present";
}

async function validate_conversion_report(
  path: string,
  reference: string,
  expectation: ConversionExpectation,
): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(await Deno.readTextFile(path));
  } catch (cause) {
    throw new Error(
      `${reference} conversion report ${JSON.stringify(path)} is invalid`,
      { cause },
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${reference} conversion report must be an object`);
  }
  const report = value as Record<string, unknown>;
  const mesh_object_count = positive_integer(
    report.mesh_object_count,
    `${reference} mesh object count`,
  );
  const material_count = nonnegative_integer(
    report.material_count,
    `${reference} material count`,
  );
  const image_count = nonnegative_integer(
    report.image_count,
    `${reference} image count`,
  );
  require_presence(
    material_count,
    expectation.expected_materials,
    `${reference} materials`,
  );
  require_presence(
    image_count,
    expectation.expected_images,
    `${reference} images`,
  );
  console.log(
    `${reference} conversion retained ${mesh_object_count} mesh objects, ${material_count} materials, and ${image_count} images`,
  );
}

function require_presence(
  count: number,
  expected: "absent" | "present",
  label: string,
): void {
  if (expected === "present" && count === 0) {
    throw new Error(`${label} are missing from the converted source`);
  }
  if (expected === "absent" && count !== 0) {
    throw new Error(
      `${label} unexpectedly contain ${count} records; update the pinned source policy before publishing them`,
    );
  }
}

function positive_integer(value: unknown, label: string): number {
  const parsed = nonnegative_integer(value, label);
  if (parsed === 0) throw new Error(`${label} must be positive; received 0`);
  return parsed;
}

function nonnegative_integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(
      `${label} must be a nonnegative safe integer; received ${
        JSON.stringify(value)
      }`,
    );
  }
  return value as number;
}
