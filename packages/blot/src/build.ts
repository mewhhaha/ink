import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type AuthoredAsset,
  build_asset_manifest,
  serialize_asset_manifest,
} from "@ink/assets/build.ts";
// @ts-types="./compiler_api.d.ts"
import {
  type DevelopmentBuild,
  DevelopmentProject,
  type DevelopmentUnitArtifact,
} from "@mewhhaha/blot/compiler";
import {
  blot_development_revision_format,
  blot_development_revision_version,
  type BlotDevelopmentArtifactReference,
  type BlotDevelopmentEdge,
  type BlotDevelopmentRetainedUnit,
  type BlotDevelopmentRevisionDescriptor,
} from "./development.ts";

export interface BlotGameBuild {
  readonly artifact_name: string;
  readonly assets_directory?: URL;
  readonly compiler: URL;
  readonly entrypoint: URL;
  readonly generated_assets?: readonly AuthoredAsset[];
  readonly public_directory: URL;
  readonly working_directory: URL;
}

export interface BlotAssetBuild {
  readonly assets_directory?: URL;
  readonly generated_assets?: readonly AuthoredAsset[];
  readonly public_directory: URL;
}

export interface BlotDevelopmentGameBuild {
  readonly artifact_name: string;
  readonly compiler_distribution: {
    readonly wasm: URL;
    readonly prelude_snapshot: URL;
  };
  readonly project_manifest: URL;
  readonly public_directory: URL;
}

export type BlotDevelopmentBuildRequest =
  | { readonly type: "initial" }
  | {
    readonly type: "sources";
    readonly changes: readonly {
      readonly path: string;
      readonly type: "create" | "update" | "delete";
    }[];
  };

export interface BlotDevelopmentBuild {
  run(request: BlotDevelopmentBuildRequest): Promise<void>;
  close(): void;
}

export function create_serial_blot_project_publisher(
  publish_revision: () => Promise<void>,
): () => Promise<void> {
  let previous_publication = Promise.resolve();
  return () => {
    const publication = previous_publication.then(
      publish_revision,
      publish_revision,
    );
    previous_publication = publication.then(
      () => undefined,
      () => undefined,
    );
    return publication;
  };
}

export function create_blot_development_build(
  game: BlotDevelopmentGameBuild,
): BlotDevelopmentBuild {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(game.artifact_name)) {
    throw new Error(
      `Ink artifact name ${
        JSON.stringify(game.artifact_name)
      } must be a stable filename`,
    );
  }
  let project: DevelopmentProject | undefined;
  let published_units = new Map<string, BlotDevelopmentArtifactReference>();
  let closed = false;
  let running = false;
  return {
    async run(request) {
      if (closed) throw new Error("Blot development build is closed");
      if (running) {
        throw new Error("Blot development build is already running");
      }
      const parsed_request = parse_development_build_request(request);
      running = true;
      try {
        project ??= await DevelopmentProject.create(
          fileURLToPath(game.project_manifest),
          {
            wasm: new Uint8Array(
              await readFile(game.compiler_distribution.wasm),
            ),
            preludeSnapshot: new Uint8Array(
              await readFile(game.compiler_distribution.prelude_snapshot),
            ),
          },
        );
        if (parsed_request.type === "sources") {
          for (const change of parsed_request.changes) {
            await project.markChanged(change.path);
          }
        }
        const build = await project.prepareBuild();
        published_units = await publish_development_build(
          game,
          project,
          build,
          published_units,
        );
        console.log(
          `Blot development ${build.revision.slice(0, 12)}: changed [${
            build.changedUnits.map(({ name }) => name).join(", ")
          }], retained [${
            build.retainedUnits.map(({ name }) => name).join(", ")
          }] in ${build.durationMilliseconds.toFixed(1)} ms`,
        );
      } finally {
        running = false;
        if (closed) {
          project?.destroy();
          project = undefined;
        }
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (!running) {
        project?.destroy();
        project = undefined;
      }
    },
  };
}

async function publish_development_build(
  game: BlotDevelopmentGameBuild,
  project: DevelopmentProject,
  build: DevelopmentBuild,
  published_units: ReadonlyMap<string, BlotDevelopmentArtifactReference>,
): Promise<Map<string, BlotDevelopmentArtifactReference>> {
  const descriptor_path = new URL(
    `${game.artifact_name}.development.json`,
    game.public_directory,
  );
  let previous_descriptor: Uint8Array | undefined;
  let descriptor_published = false;
  let build_committed = false;
  try {
    const next_units = apply_development_build(published_units, build);
    const descriptor = development_revision_descriptor(build, next_units);
    const descriptor_bytes = new TextEncoder().encode(
      `${JSON.stringify(descriptor, null, 2)}\n`,
    );
    previous_descriptor = await read_optional_file(descriptor_path);
    await Promise.all(
      build.changedUnits.flatMap((unit) => [
        write_immutable_development_artifact(
          new URL(
            development_wasm_path(unit.wasmDigest),
            game.public_directory,
          ),
          unit.wasm,
        ),
        write_immutable_development_artifact(
          new URL(
            development_manifest_path(unit.interfaceDigest),
            game.public_directory,
          ),
          unit.manifestBytes,
        ),
      ]),
    );
    await write_development_artifact(descriptor_path, descriptor_bytes);
    descriptor_published = true;
    project.commitBuild(build);
    build_committed = true;
    return next_units;
  } catch (error) {
    const failures: unknown[] = [error];
    if (!build_committed) {
      try {
        project.abortBuild(build);
      } catch (abort_error) {
        failures.push(abort_error);
      }
    }
    if (descriptor_published) {
      try {
        if (previous_descriptor === undefined) {
          await rm(descriptor_path, { force: true });
        } else {
          await write_development_artifact(
            descriptor_path,
            previous_descriptor,
          );
        }
      } catch (rollback_error) {
        failures.push(rollback_error);
      }
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(
      failures,
      `Blot development revision ${
        JSON.stringify(build.revision)
      } publication and rollback failed`,
    );
  }
}

function apply_development_build(
  published_units: ReadonlyMap<string, BlotDevelopmentArtifactReference>,
  build: DevelopmentBuild,
): Map<string, BlotDevelopmentArtifactReference> {
  const next_units = new Map(published_units);
  for (const removed of build.removedUnits) next_units.delete(removed);
  for (const unit of build.changedUnits) {
    next_units.set(unit.name, development_artifact_reference(unit));
  }
  for (const retained of build.retainedUnits) {
    const current = next_units.get(retained.name);
    if (current === undefined) {
      throw new Error(
        `Blot development revision ${
          JSON.stringify(build.revision)
        } retained unpublished unit ${JSON.stringify(retained.name)}`,
      );
    }
    if (
      current.interface_digest !== retained.interfaceDigest ||
      current.implementation_digest !== retained.implementationDigest ||
      current.wasm_digest !== retained.wasmDigest
    ) {
      throw new Error(
        `Blot development revision ${
          JSON.stringify(build.revision)
        } retained stale unit ${JSON.stringify(retained.name)}`,
      );
    }
  }
  const classified = new Set([
    ...build.changedUnits.map(({ name }) => name),
    ...build.retainedUnits.map(({ name }) => name),
  ]);
  const final_names = [...next_units.keys()].toSorted();
  const classified_names = [...classified].toSorted();
  if (JSON.stringify(final_names) !== JSON.stringify(classified_names)) {
    throw new Error(
      `Blot development revision ${
        JSON.stringify(build.revision)
      } final units ${
        JSON.stringify(final_names)
      } differ from classified units ${JSON.stringify(classified_names)}`,
    );
  }
  if (!next_units.has(build.entryUnit)) {
    throw new Error(
      `Blot development revision ${
        JSON.stringify(build.revision)
      } omits entry unit ${JSON.stringify(build.entryUnit)}`,
    );
  }
  return next_units;
}

function development_revision_descriptor(
  build: DevelopmentBuild,
  units: ReadonlyMap<string, BlotDevelopmentArtifactReference>,
): BlotDevelopmentRevisionDescriptor {
  const snapshot_units = Object.freeze(
    [...units.values()].toSorted((left, right) =>
      left.name.localeCompare(right.name)
    ),
  );
  const edges = Object.freeze(
    build.edges.map(development_edge).toSorted(compare_development_edges),
  );
  return Object.freeze({
    format: blot_development_revision_format,
    version: blot_development_revision_version,
    revision: build.revision,
    snapshot: Object.freeze({
      entry_unit: build.entryUnit,
      units: snapshot_units,
      edges,
    }),
    delta: Object.freeze({
      base_revision: build.baseRevision ?? null,
      changed_units: Object.freeze(
        build.changedUnits.map(development_artifact_reference).toSorted(
          (left, right) => left.name.localeCompare(right.name),
        ),
      ),
      retained_units: Object.freeze(
        build.retainedUnits.map((unit): BlotDevelopmentRetainedUnit =>
          Object.freeze({
            name: unit.name,
            interface_digest: unit.interfaceDigest,
            implementation_digest: unit.implementationDigest,
            wasm_digest: unit.wasmDigest,
          })
        ).toSorted((left, right) => left.name.localeCompare(right.name)),
      ),
      removed_units: Object.freeze([...build.removedUnits].toSorted()),
      edges,
      duration_milliseconds: build.durationMilliseconds,
    }),
  });
}

function development_artifact_reference(
  unit: DevelopmentUnitArtifact,
): BlotDevelopmentArtifactReference {
  return Object.freeze({
    name: unit.name,
    root: unit.root,
    capabilities: Object.freeze([...unit.capabilities].toSorted()),
    interface_digest: unit.interfaceDigest,
    implementation_digest: unit.implementationDigest,
    wasm_digest: unit.wasmDigest,
    artifact_source: unit.artifactSource,
    wasm_path: development_wasm_path(unit.wasmDigest),
    manifest_path: development_manifest_path(unit.interfaceDigest),
  });
}

function development_edge(
  edge: DevelopmentBuild["edges"][number],
): BlotDevelopmentEdge {
  return Object.freeze({
    consumer: edge.consumer,
    provider: edge.provider,
    name: edge.name,
  });
}

function compare_development_edges(
  left: BlotDevelopmentEdge,
  right: BlotDevelopmentEdge,
): number {
  return left.consumer.localeCompare(right.consumer) ||
    left.provider.localeCompare(right.provider) ||
    left.name.localeCompare(right.name);
}

function development_wasm_path(digest: string): string {
  return `.ink/blot/${digest}.wasm`;
}

function development_manifest_path(digest: string): string {
  return `.ink/blot/${digest}.wasm.json`;
}

async function write_immutable_development_artifact(
  path: URL,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(dirname(fileURLToPath(path)), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if (!node_error_has_code(error, "EEXIST")) throw error;
    const existing = await readFile(path);
    if (!bytes_equal(existing, bytes)) {
      throw new Error(
        `content-addressed Blot artifact ${
          JSON.stringify(fileURLToPath(path))
        } already exists with different bytes`,
      );
    }
  }
}

async function read_optional_file(path: URL): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if (node_error_has_code(error, "ENOENT")) return undefined;
    throw error;
  }
}

function node_error_has_code(error: unknown, expected: string): boolean {
  return error instanceof Error && "code" in error &&
    Reflect.get(error, "code") === expected;
}

function parse_development_build_request(
  request: unknown,
): BlotDevelopmentBuildRequest {
  if (typeof request !== "object" || request === null) {
    throw new Error("Blot development build request must be an object");
  }
  const type = Reflect.get(request, "type");
  if (type === "initial") {
    if (Object.keys(request).length !== 1) {
      throw new Error("Blot initial build request must contain only type");
    }
    return { type };
  }
  const changes = Reflect.get(request, "changes");
  if (type !== "sources" || !Array.isArray(changes)) {
    throw new Error(
      `Blot development build request type ${
        JSON.stringify(type)
      } must be "initial" or "sources" with changes`,
    );
  }
  if (Object.keys(request).toSorted().join(",") !== "changes,type") {
    throw new Error("Blot source build request must contain changes and type");
  }
  return Object.freeze({
    type,
    changes: Object.freeze(changes.map((change, index) => {
      if (typeof change !== "object" || change === null) {
        throw new Error(`Blot source change ${index} must be an object`);
      }
      const path = Reflect.get(change, "path");
      const change_type = Reflect.get(change, "type");
      if (typeof path !== "string" || !isAbsolute(path)) {
        throw new Error(
          `Blot source change ${index} path ${
            JSON.stringify(path)
          } must be absolute`,
        );
      }
      if (
        change_type !== "create" && change_type !== "update" &&
        change_type !== "delete"
      ) {
        throw new Error(
          `Blot source change ${index} type ${
            JSON.stringify(change_type)
          } is unsupported`,
        );
      }
      if (Object.keys(change).toSorted().join(",") !== "path,type") {
        throw new Error(
          `Blot source change ${index} must contain path and type`,
        );
      }
      return Object.freeze({ path, type: change_type });
    })),
  });
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
  const build_lock_path = new URL(
    ".ink-publication.lock/",
    game.public_directory,
  );
  const generated_wasm = new URL(
    `${game.artifact_name}.wasm`,
    game.public_directory,
  );
  const generated_manifest = new URL(
    `${game.artifact_name}.wasm.json`,
    game.public_directory,
  );
  const pending_wasm = new URL(
    `.${game.artifact_name}.wasm.${process.pid}.pending`,
    game.public_directory,
  );
  const pending_manifest = new URL(
    `.${game.artifact_name}.wasm.json.${process.pid}.pending`,
    game.public_directory,
  );
  const pending_asset_manifest = new URL(
    `.assets.manifest.json.${process.pid}.pending`,
    game.public_directory,
  );
  const compiler_wasm = pathToFileURL(
    `${entrypoint_path.slice(0, -extname(entrypoint_path).length)}.wasm`,
  );
  const compiler_manifest = pathToFileURL(
    `${fileURLToPath(compiler_wasm)}.json`,
  );

  await mkdir(public_directory, { recursive: true });
  const build_lock = await acquire_blot_build_lock(build_lock_path);
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

    const asset_artifacts = await prepare_blot_assets(
      game,
      generated_asset_manifest,
      pending_asset_manifest,
    );
    await Promise.all([
      copyFile(compiler_wasm, pending_wasm),
      copyFile(compiler_manifest, pending_manifest),
    ]);
    await Promise.all([
      rename(pending_wasm, generated_wasm),
      rename(pending_manifest, generated_manifest),
      rename(pending_asset_manifest, generated_asset_manifest),
    ]);
    await prune_content_artifacts(published_assets, asset_artifacts);
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
      await build_lock.close();
    }
  }
}

export async function publish_blot_assets(
  build: BlotAssetBuild,
): Promise<void> {
  const public_directory = fileURLToPath(build.public_directory);
  const published_assets = new URL("assets/", build.public_directory);
  const generated_manifest = new URL(
    "assets.manifest.json",
    build.public_directory,
  );
  const pending_manifest = new URL(
    `.assets.manifest.json.${process.pid}.pending`,
    build.public_directory,
  );
  const build_lock_path = new URL(
    ".ink-publication.lock/",
    build.public_directory,
  );

  await mkdir(public_directory, { recursive: true });
  const build_lock = await acquire_blot_build_lock(build_lock_path);
  try {
    const artifacts = await prepare_blot_assets(
      build,
      generated_manifest,
      pending_manifest,
    );
    await rename(pending_manifest, generated_manifest);
    await prune_content_artifacts(published_assets, artifacts);
  } finally {
    try {
      await remove_if_present(pending_manifest);
    } finally {
      await build_lock.close();
    }
  }
}

async function prepare_blot_assets(
  build: BlotAssetBuild,
  generated_manifest: URL,
  pending_manifest: URL,
): Promise<readonly { readonly location: string }[]> {
  const published_assets = new URL("assets/", build.public_directory);
  const authored_assets = build.assets_directory === undefined
    ? []
    : await collect_authored_assets(build.assets_directory);
  const generated_assets = (build.generated_assets ?? []).map(
    parse_generated_asset,
  );
  const asset_build = await build_asset_manifest(
    [...authored_assets, ...generated_assets],
    fileURLToPath(generated_manifest),
  );

  await clear_authored_assets(published_assets);
  for (const artifact of asset_build.artifacts) {
    await write_content_artifact(
      new URL(artifact.location, build.public_directory),
      artifact.bytes,
    );
  }
  await writeFile(
    pending_manifest,
    serialize_asset_manifest(asset_build.manifest),
  );
  return asset_build.artifacts;
}

async function prune_content_artifacts(
  published_assets: URL,
  artifacts: readonly { readonly location: string }[],
): Promise<void> {
  const content_directory = new URL(".ink/", published_assets);
  const retained = new Set(
    artifacts.map(({ location }) => {
      const prefix = "assets/.ink/";
      if (!location.startsWith(prefix)) {
        throw new Error(
          `generated asset location ${
            JSON.stringify(location)
          } is outside the content store ${JSON.stringify(prefix)}`,
        );
      }
      return location.slice(prefix.length);
    }),
  );
  try {
    for (
      const entry of await readdir(content_directory, {
        withFileTypes: true,
      })
    ) {
      if (!entry.isFile()) {
        throw new Error(
          `generated content store entry ${
            JSON.stringify(
              fileURLToPath(new URL(entry.name, content_directory)),
            )
          } is not a file`,
        );
      }
      if (retained.has(entry.name)) continue;
      await rm(new URL(entry.name, content_directory));
    }
  } catch (error) {
    if (!node_error_has_code(error, "ENOENT")) throw error;
  }
}

async function collect_authored_assets(
  directory: URL,
  prefix = "",
): Promise<readonly AuthoredAsset[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const assets: AuthoredAsset[] = [];
  for (const entry of entries) {
    const id = `${prefix}${entry.name}`;
    const source = new URL(entry.name, directory);
    if (entry.isDirectory()) {
      assets.push(
        ...await collect_authored_assets(
          new URL(`${entry.name}/`, directory),
          `${id}/`,
        ),
      );
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `game asset ${JSON.stringify(fileURLToPath(source))} is not a file`,
      );
    }
    const extension = extname(entry.name).slice(1).toLowerCase();
    assets.push({
      id,
      kind: extension.length === 0 ? "binary" : extension,
      bytes: new Uint8Array(await readFile(source)),
    });
  }
  return assets;
}

async function clear_authored_assets(directory: URL): Promise<void> {
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".ink" && entry.isDirectory()) continue;
      await rm(new URL(entry.name, directory), {
        recursive: entry.isDirectory(),
      });
    }
  } catch (error) {
    if (!node_error_has_code(error, "ENOENT")) throw error;
  }
}

async function write_content_artifact(
  path: URL,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(new URL("./", path), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if (!node_error_has_code(error, "EEXIST")) throw error;
    const existing = await readFile(path);
    if (!bytes_equal(existing, bytes)) {
      throw new Error(
        `content-addressed asset ${
          JSON.stringify(fileURLToPath(path))
        } already exists with different bytes`,
      );
    }
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

async function acquire_blot_build_lock(
  path: URL,
): Promise<{ readonly close: () => Promise<void> }> {
  try {
    await mkdir(path);
  } catch (error) {
    if (!node_error_has_code(error, "EEXIST")) throw error;
    throw new Error(
      `Blot output ${
        JSON.stringify(fileURLToPath(new URL("../", path)))
      } is already being published`,
      { cause: error },
    );
  }
  return Object.freeze({
    close: () => rm(path, { recursive: true }),
  });
}

async function remove_if_present(path: URL): Promise<void> {
  await rm(path, { force: true });
}
