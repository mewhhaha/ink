import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type AuthoredAsset,
  build_asset_manifest,
  serialize_asset_manifest,
} from "@ink/assets/build.ts";

export interface BlotGameBuild {
  readonly artifact_name: string;
  readonly assets_directory: URL;
  readonly compiler: URL;
  readonly entrypoint: URL;
  readonly generated_assets?: readonly AuthoredAsset[];
  readonly public_directory: URL;
  readonly working_directory: URL;
}

export interface BlotDevelopmentGameBuild {
  readonly artifact_name: string;
  readonly compiler_module: URL;
  readonly entrypoint: URL;
  readonly project_manifest: URL;
  readonly public_directory: URL;
}

export interface BlotDevelopmentBuild {
  run(): Promise<void>;
  close(): void;
}

interface DevelopmentUnitArtifact {
  readonly manifestBytes: Uint8Array;
  readonly name: string;
  readonly wasm: Uint8Array;
}

interface DevelopmentBuildResult {
  readonly changedUnits: readonly DevelopmentUnitArtifact[];
  readonly durationMilliseconds: number;
  readonly entryUnit: string;
  readonly retainedUnits: readonly { readonly name: string }[];
  readonly revision: string;
}

interface DevelopmentProject {
  build(): Promise<unknown>;
  destroy(): void;
  markChanged(path: string): Promise<void>;
}

export function create_blot_development_build(
  game: BlotDevelopmentGameBuild,
): BlotDevelopmentBuild {
  let project: DevelopmentProject | undefined;
  let closed = false;
  return {
    async run() {
      if (closed) throw new Error("Blot development build is closed");
      if (project === undefined) {
        const compiler: unknown = await import(game.compiler_module.href);
        const development_project = is_record(compiler)
          ? compiler.DevelopmentProject
          : undefined;
        if (
          typeof development_project !== "function" ||
          !("create" in development_project) ||
          typeof development_project.create !== "function"
        ) {
          throw new Error(
            `Blot compiler module ${game.compiler_module} does not export DevelopmentProject.create`,
          );
        }
        const created: unknown = await development_project.create(
          fileURLToPath(game.project_manifest),
        );
        project = parse_development_project(created, game.compiler_module);
      }
      await project.markChanged(fileURLToPath(game.entrypoint));
      const build = parse_development_build(
        await project.build(),
        game.project_manifest,
      );
      const unsupported = [
        ...build.changedUnits,
        ...build.retainedUnits,
      ].filter((unit) => unit.name !== build.entryUnit);
      if (unsupported.length > 0) {
        throw new Error(
          `Ink Blot development runtime requires one unit; project ${game.project_manifest} also contains ${
            unsupported.map((unit) => JSON.stringify(unit.name)).join(", ")
          }`,
        );
      }
      const entry = build.changedUnits.find((unit) =>
        unit.name === build.entryUnit
      );
      console.log(
        `Blot development ${build.revision.slice(0, 12)}: ${
          entry === undefined ? "retained" : "changed"
        } ${build.entryUnit} in ${build.durationMilliseconds.toFixed(1)} ms`,
      );
      if (entry === undefined) return;
      await Promise.all([
        write_development_artifact(
          new URL(`${game.artifact_name}.wasm`, game.public_directory),
          entry.wasm,
        ),
        write_development_artifact(
          new URL(`${game.artifact_name}.wasm.json`, game.public_directory),
          entry.manifestBytes,
        ),
      ]);
    },
    close() {
      if (closed) return;
      closed = true;
      project?.destroy();
      project = undefined;
    },
  };
}

export async function build_blot_game(game: BlotGameBuild): Promise<void> {
  if (
    typeof game.artifact_name !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(game.artifact_name)
  ) {
    throw new Error(
      `Ink artifact name ${
        JSON.stringify(game.artifact_name)
      } must be a stable filename`,
    );
  }
  const entrypoint_path = fileURLToPath(game.entrypoint);
  if (extname(entrypoint_path) !== ".blot") {
    throw new Error(
      `Ink game entrypoint ${
        JSON.stringify(entrypoint_path)
      } must end in .blot`,
    );
  }

  const public_directory = fileURLToPath(game.public_directory);
  const published_assets = new URL("assets/", game.public_directory);
  const generated_asset_manifest = new URL(
    "assets.manifest.json",
    game.public_directory,
  );
  const build_lock_path = new URL(".ink-build.lock", game.public_directory);
  const generated_wasm = new URL(
    `${game.artifact_name}.wasm`,
    game.public_directory,
  );
  const generated_manifest = new URL(
    `${game.artifact_name}.wasm.json`,
    game.public_directory,
  );
  const pending_wasm = new URL(
    `.${game.artifact_name}.wasm.${Deno.pid}.pending`,
    game.public_directory,
  );
  const pending_manifest = new URL(
    `.${game.artifact_name}.wasm.json.${Deno.pid}.pending`,
    game.public_directory,
  );
  const pending_asset_manifest = new URL(
    `.assets.manifest.json.${Deno.pid}.pending`,
    game.public_directory,
  );
  const compiler_wasm = pathToFileURL(
    `${entrypoint_path.slice(0, -extname(entrypoint_path).length)}.wasm`,
  );
  const compiler_manifest = pathToFileURL(
    `${fileURLToPath(compiler_wasm)}.json`,
  );

  await Deno.mkdir(public_directory, { recursive: true });
  const build_lock = await Deno.open(build_lock_path, {
    create: true,
    write: true,
  });
  await build_lock.lock(true);
  try {
    const build = new Deno.Command(Deno.execPath(), {
      cwd: fileURLToPath(game.working_directory),
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        fileURLToPath(game.compiler),
        "build",
        entrypoint_path,
      ],
      stdout: "inherit",
      stderr: "inherit",
    });
    const built = await build.output();
    if (!built.success) {
      throw new Error(
        `Blot build for ${
          JSON.stringify(entrypoint_path)
        } exited with code ${built.code}`,
      );
    }

    const authored_assets = await collect_authored_assets(
      game.assets_directory,
    );
    const compiled_assets = (game.generated_assets ?? []).map(
      parse_generated_asset,
    );
    const asset_build = await build_asset_manifest(
      [...authored_assets, ...compiled_assets],
      fileURLToPath(generated_asset_manifest),
    );
    await clear_authored_assets(published_assets);
    await copy_directory(game.assets_directory, published_assets);
    for (const asset of compiled_assets) {
      await write_replaced_file(
        new URL(`assets/${asset.id}`, game.public_directory),
        asset.bytes,
      );
    }
    for (const artifact of asset_build.artifacts) {
      await write_content_artifact(
        new URL(artifact.location, game.public_directory),
        artifact.bytes,
      );
    }
    await Deno.writeTextFile(
      pending_asset_manifest,
      serialize_asset_manifest(asset_build.manifest),
    );
    await Promise.all([
      Deno.copyFile(compiler_wasm, pending_wasm),
      Deno.copyFile(compiler_manifest, pending_manifest),
    ]);
    await Promise.all([
      Deno.rename(pending_wasm, generated_wasm),
      Deno.rename(pending_manifest, generated_manifest),
      Deno.rename(pending_asset_manifest, generated_asset_manifest),
    ]);
  } finally {
    try {
      await Promise.all([
        remove_if_present(compiler_wasm),
        remove_if_present(compiler_manifest),
        remove_if_present(pending_wasm),
        remove_if_present(pending_manifest),
        remove_if_present(pending_asset_manifest),
      ]);
    } finally {
      await build_lock.unlock();
      build_lock.close();
    }
  }
}

async function collect_authored_assets(
  directory: URL,
  prefix = "",
): Promise<readonly AuthoredAsset[]> {
  const entries = [];
  for await (const entry of Deno.readDir(directory)) entries.push(entry);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const assets: AuthoredAsset[] = [];
  for (const entry of entries) {
    const id = `${prefix}${entry.name}`;
    const source = new URL(entry.name, directory);
    if (entry.isDirectory) {
      assets.push(
        ...await collect_authored_assets(
          new URL(`${entry.name}/`, directory),
          `${id}/`,
        ),
      );
      continue;
    }
    if (!entry.isFile) {
      throw new Error(
        `game asset ${JSON.stringify(fileURLToPath(source))} is not a file`,
      );
    }
    const extension = extname(entry.name).slice(1).toLowerCase();
    assets.push({
      id,
      kind: extension.length === 0 ? "binary" : extension,
      bytes: await Deno.readFile(source),
    });
  }
  return assets;
}

async function clear_authored_assets(directory: URL): Promise<void> {
  try {
    for await (const entry of Deno.readDir(directory)) {
      if (entry.name === ".ink" && entry.isDirectory) continue;
      await Deno.remove(new URL(entry.name, directory), {
        recursive: entry.isDirectory,
      });
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function write_content_artifact(
  path: URL,
  bytes: Uint8Array,
): Promise<void> {
  await Deno.mkdir(new URL("./", path), { recursive: true });
  try {
    await Deno.writeFile(path, bytes, { createNew: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    const existing = await Deno.readFile(path);
    if (!bytes_equal(existing, bytes)) {
      throw new Error(
        `content-addressed asset ${
          JSON.stringify(fileURLToPath(path))
        } already exists with different bytes`,
      );
    }
  }
}

async function write_replaced_file(
  path: URL,
  bytes: Uint8Array,
): Promise<void> {
  await Deno.mkdir(new URL("./", path), { recursive: true });
  const pending = new URL(
    `.${path.pathname.split("/").at(-1)}.${Deno.pid}.pending`,
    new URL("./", path),
  );
  try {
    await Deno.writeFile(pending, bytes);
    await Deno.rename(pending, path);
  } finally {
    await remove_if_present(pending);
  }
}

async function write_development_artifact(
  path: URL,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(dirname(fileURLToPath(path)), { recursive: true });
  const pending = new URL(
    `.${path.pathname.split("/").at(-1)}.${process.pid}.pending`,
    new URL("./", path),
  );
  try {
    await writeFile(pending, bytes);
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
}

function parse_generated_asset(asset: AuthoredAsset): AuthoredAsset {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(asset.id) ||
    asset.id.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(
      `generated Blot asset id ${JSON.stringify(asset.id)} is not a safe path`,
    );
  }
  if (!(asset.bytes instanceof Uint8Array)) {
    throw new Error(
      `generated Blot asset ${
        JSON.stringify(asset.id)
      } bytes must be a Uint8Array`,
    );
  }
  return Object.freeze({
    id: asset.id,
    kind: asset.kind,
    bytes: new Uint8Array(asset.bytes),
    ...(asset.dependencies === undefined
      ? {}
      : { dependencies: Object.freeze([...asset.dependencies]) }),
  });
}

function bytes_equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

async function copy_directory(source: URL, destination: URL): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const source_entry = new URL(entry.name, source);
    const destination_entry = new URL(entry.name, destination);
    if (entry.isDirectory) {
      await copy_directory(
        new URL(`${entry.name}/`, source),
        new URL(`${entry.name}/`, destination),
      );
      continue;
    }
    if (!entry.isFile) {
      throw new Error(
        `game asset ${
          JSON.stringify(fileURLToPath(source_entry))
        } is not a file`,
      );
    }
    await Deno.copyFile(source_entry, destination_entry);
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

function parse_development_project(
  value: unknown,
  compiler_module: URL,
): DevelopmentProject {
  if (
    !is_record(value) || typeof value.build !== "function" ||
    typeof value.destroy !== "function" ||
    typeof value.markChanged !== "function"
  ) {
    throw new Error(
      `Blot compiler module ${compiler_module} returned an invalid DevelopmentProject`,
    );
  }
  return value as unknown as DevelopmentProject;
}

function parse_development_build(
  value: unknown,
  project_manifest: URL,
): DevelopmentBuildResult {
  if (
    !is_record(value) || typeof value.entryUnit !== "string" ||
    typeof value.revision !== "string" ||
    typeof value.durationMilliseconds !== "number" ||
    !Number.isFinite(value.durationMilliseconds) ||
    value.durationMilliseconds < 0 ||
    !Array.isArray(value.changedUnits) || !Array.isArray(value.retainedUnits)
  ) {
    throw new Error(
      `Blot project ${project_manifest} returned an invalid development build`,
    );
  }
  const changedUnits = value.changedUnits.map((unit, index) => {
    if (
      !is_record(unit) || typeof unit.name !== "string" ||
      !(unit.wasm instanceof Uint8Array) ||
      !(unit.manifestBytes instanceof Uint8Array)
    ) {
      throw new Error(
        `Blot project ${project_manifest} returned invalid changed unit ${index}`,
      );
    }
    return {
      name: unit.name,
      wasm: unit.wasm,
      manifestBytes: unit.manifestBytes,
    };
  });
  const retainedUnits = value.retainedUnits.map((unit, index) => {
    if (!is_record(unit) || typeof unit.name !== "string") {
      throw new Error(
        `Blot project ${project_manifest} returned invalid retained unit ${index}`,
      );
    }
    return { name: unit.name };
  });
  return {
    entryUnit: value.entryUnit,
    revision: value.revision,
    durationMilliseconds: value.durationMilliseconds,
    changedUnits,
    retainedUnits,
  };
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
