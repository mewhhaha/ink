import { extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type AuthoredAsset,
  build_asset_manifest,
  serialize_asset_manifest,
} from "@ink/assets/build.ts";

export interface InkGameBuild {
  readonly artifact_name: string;
  readonly assets_directory: URL;
  readonly compiler: URL;
  readonly entrypoint: URL;
  readonly public_directory: URL;
  readonly working_directory: URL;
}

export async function build_ink_game(game: InkGameBuild): Promise<void> {
  const entrypoint_path = fileURLToPath(game.entrypoint);
  if (extname(entrypoint_path) !== ".blot") {
    throw new Error(
      `Ink game entrypoint ${
        JSON.stringify(entrypoint_path)
      } must end in .blot`,
    );
  }

  const public_directory = fileURLToPath(game.public_directory);
  const generated_assets = new URL("assets/", game.public_directory);
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
    const asset_build = await build_asset_manifest(
      authored_assets,
      fileURLToPath(generated_asset_manifest),
    );
    await clear_authored_assets(generated_assets);
    await copy_directory(game.assets_directory, generated_assets);
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
