import {
  type AuthoredAsset,
  build_asset_manifest,
  serialize_asset_manifest,
} from "../packages/assets/src/build.ts";
import { digest_bytes, verify_digest } from "../packages/assets/src/digest.ts";
import {
  content_digest,
  type ContentDigest,
} from "../packages/assets/src/identity.ts";
import { parse_static_glb_scene } from "../packages/assets/src/gltf_model.ts";
import {
  build_prepared_static_gltf_scene,
} from "../packages/assets/src/prepared_scene.ts";

export const lighting_asset_catalog_version = 1 as const;

export type LightingReferenceName = "bistro" | "caldera" | "fog-room";

export interface LightingSource {
  readonly name: LightingReferenceName;
  readonly path: URL;
  readonly public_source: string;
  readonly required: boolean;
}

export type LightingCatalogScene =
  | {
    readonly type: "ready";
    readonly root: string;
    readonly source: string;
    readonly source_materials: "embedded" | "upstream-omitted";
  }
  | {
    readonly type: "unavailable";
    readonly reason: string;
    readonly source: string;
  };

export interface LightingAssetCatalog {
  readonly manifest: {
    readonly byte_size: number;
    readonly digest: string;
    readonly location: string;
  };
  readonly scenes: Readonly<
    Record<LightingReferenceName, LightingCatalogScene>
  >;
  readonly version: typeof lighting_asset_catalog_version;
}

const application_root = new URL("../apps/lighting-dev/", import.meta.url);
const generated_root = new URL("generated/", application_root);
const public_root = new URL("public/", generated_root);
const legacy_runtime_assets = new URL("assets/", generated_root);
const sources: readonly LightingSource[] = [
  {
    name: "bistro",
    path: new URL("assets/reference/BistroExterior.glb", application_root),
    public_source: "/reference/BistroExterior.glb",
    required: false,
  },
  {
    name: "caldera",
    path: new URL("assets/reference/CalderaHotel.glb", application_root),
    public_source: "/reference/CalderaHotel.glb",
    required: false,
  },
  {
    name: "fog-room",
    path: new URL("assets/bevy/VolumetricFogExample.glb", application_root),
    public_source: "/bevy/VolumetricFogExample.glb",
    required: true,
  },
];

if (import.meta.main) await build_lighting_assets();

export async function build_lighting_assets(): Promise<void> {
  await Deno.mkdir(generated_root, { recursive: true });
  const staging_path = await Deno.makeTempDir({
    dir: generated_root.pathname,
    prefix: ".lighting-assets-",
  });
  const staging_root = new URL(`${staging_path}/`, "file://");
  try {
    const catalog = await write_lighting_assets(staging_root, sources);
    await publish_lighting_assets(staging_root, public_root);
    await remove_if_present(staging_root);
    await remove_if_present(legacy_runtime_assets);
    await remove_if_present(new URL("prepared/manifest.json", public_root));
    const ready = Object.entries(catalog.scenes)
      .filter(([, scene]) => scene.type === "ready")
      .map(([name]) => name)
      .join(", ");
    console.log(`prepared lighting assets: ${ready}`);
  } catch (error) {
    await remove_if_present(staging_root);
    throw error;
  }
}

export async function write_lighting_assets(
  output_root: URL,
  scene_sources: readonly LightingSource[],
): Promise<LightingAssetCatalog> {
  const authored_assets: AuthoredAsset[] = [];
  const catalog_scenes = new Map<LightingReferenceName, LightingCatalogScene>();
  for (const source of scene_sources) {
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(source.path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      if (source.required) {
        throw new Error(
          `lighting source ${source.path.pathname} is missing; run pnpm sync:bevy-scene`,
        );
      }
      catalog_scenes.set(source.name, {
        type: "unavailable",
        reason:
          `source ${source.path.pathname} is not installed; run pnpm sync:lighting-scenes`,
        source: source.public_source,
      });
      continue;
    }
    const scene = parse_static_glb_scene(bytes, source.public_source);
    const prepared = build_prepared_static_gltf_scene(
      `lighting/${source.name}`,
      scene,
    );
    authored_assets.push(...prepared.assets);
    catalog_scenes.set(source.name, {
      type: "ready",
      root: prepared.root,
      source: source.public_source,
      source_materials: source.name === "caldera" && scene.textures.length === 0
        ? "upstream-omitted"
        : "embedded",
    });
  }
  const scenes = complete_catalog(catalog_scenes, scene_sources);
  const build = await build_asset_manifest(
    authored_assets,
    "lighting/prepared/manifest.json",
  );
  const manifest_bytes = new TextEncoder().encode(
    serialize_asset_manifest(build.manifest),
  );
  const manifest_digest = await digest_bytes(manifest_bytes);
  const manifest_name = `${manifest_digest.slice("sha256:".length)}.json`;
  const catalog: LightingAssetCatalog = Object.freeze({
    manifest: Object.freeze({
      byte_size: manifest_bytes.length,
      digest: manifest_digest,
      location: `/prepared/manifests/${manifest_name}`,
    }),
    scenes,
    version: lighting_asset_catalog_version,
  });

  await Deno.mkdir(new URL("prepared/manifests/", output_root), {
    recursive: true,
  });
  await Deno.writeFile(
    new URL(`prepared/manifests/${manifest_name}`, output_root),
    manifest_bytes,
  );
  await Deno.writeTextFile(
    new URL("prepared/catalog.json", output_root),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
  for (const artifact of build.artifacts) {
    const destination = new URL(artifact.location, output_root);
    await Deno.mkdir(new URL("./", destination), { recursive: true });
    await Deno.writeFile(destination, artifact.bytes);
  }
  await assert_no_source_containers(output_root);
  return catalog;
}

function complete_catalog(
  scenes: ReadonlyMap<LightingReferenceName, LightingCatalogScene>,
  scene_sources: readonly LightingSource[],
): Readonly<Record<LightingReferenceName, LightingCatalogScene>> {
  const completed = new Map(scenes);
  for (const source of scene_sources) {
    if (completed.has(source.name)) continue;
    completed.set(source.name, {
      type: "unavailable",
      reason:
        `source ${source.path.pathname} was not considered by the asset build`,
      source: source.public_source,
    });
  }
  const bistro = completed.get("bistro");
  const caldera = completed.get("caldera");
  const fog_room = completed.get("fog-room");
  if (bistro === undefined || caldera === undefined || fog_room === undefined) {
    throw new Error(
      `lighting asset catalog requires bistro, caldera, and fog-room entries; received ${
        JSON.stringify([...completed.keys()])
      }`,
    );
  }
  return Object.freeze({
    bistro,
    caldera,
    "fog-room": fog_room,
  });
}

async function assert_no_source_containers(output_root: URL): Promise<void> {
  for await (const entry of Deno.readDir(output_root)) {
    await assert_not_glb(entry, output_root);
  }
}

async function assert_not_glb(
  entry: Deno.DirEntry,
  parent: URL,
): Promise<void> {
  const path = new URL(entry.name, parent);
  if (entry.isDirectory) {
    const directory = new URL(`${path.pathname}/`, path);
    for await (const child of Deno.readDir(directory)) {
      await assert_not_glb(child, directory);
    }
    return;
  }
  if (!entry.name.toLowerCase().endsWith(".glb")) return;
  throw new Error(
    `lighting runtime publication contains source GLB ${path.pathname}`,
  );
}

export async function publish_lighting_assets(
  staging: URL,
  destination: URL,
): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  const catalog_path = "prepared/catalog.json";
  for await (const relative_path of publication_files(staging)) {
    if (relative_path === catalog_path) continue;
    const source = new URL(relative_path, staging);
    const target = new URL(relative_path, destination);
    const staged_bytes = await Deno.readFile(source);
    const action = await choose_content_addressed_publication({
      relative_path,
      staged_bytes,
      published_bytes: await read_file_if_present(target),
    });
    if (action === "reuse") continue;
    await Deno.mkdir(new URL("./", target), { recursive: true });
    const pending = new URL(`${target.pathname}.pending`, target);
    await Deno.writeFile(pending, staged_bytes);
    await Deno.rename(pending, target);
  }
  const catalog = new URL(catalog_path, destination);
  await Deno.mkdir(new URL("./", catalog), { recursive: true });
  const pending_catalog = new URL(`${catalog.pathname}.pending`, catalog);
  await Deno.copyFile(new URL(catalog_path, staging), pending_catalog);
  await Deno.rename(pending_catalog, catalog);
}

export async function choose_content_addressed_publication(request: {
  readonly relative_path: string;
  readonly staged_bytes: Uint8Array;
  readonly published_bytes: Uint8Array | undefined;
}): Promise<"replace" | "reuse"> {
  const expected_digest = publication_digest(request.relative_path);
  const staged = await verify_digest(request.staged_bytes, expected_digest);
  if (staged.type === "digest_mismatch") {
    throw new Error(
      `lighting staged publication ${
        JSON.stringify(request.relative_path)
      } has digest ${staged.actual}; path declares ${staged.expected}`,
    );
  }
  if (request.published_bytes === undefined) return "replace";
  const published = await verify_digest(
    request.published_bytes,
    expected_digest,
  );
  return published.type === "verified" ? "reuse" : "replace";
}

function publication_digest(relative_path: string): ContentDigest {
  const artifact = /^assets\/\.ink\/([0-9a-f]{64})$/.exec(relative_path);
  const manifest = /^prepared\/manifests\/([0-9a-f]{64})\.json$/.exec(
    relative_path,
  );
  const hexadecimal = artifact?.[1] ?? manifest?.[1];
  if (hexadecimal === undefined) {
    throw new Error(
      `lighting publication file ${
        JSON.stringify(relative_path)
      } is not at a content-addressed artifact or manifest path`,
    );
  }
  return content_digest(`sha256:${hexadecimal}`);
}

async function* publication_files(
  root: URL,
  relative_directory = "",
): AsyncGenerator<string> {
  const directory = new URL(relative_directory, root);
  for await (const entry of Deno.readDir(directory)) {
    const relative_path = `${relative_directory}${entry.name}`;
    if (entry.isDirectory) {
      yield* publication_files(root, `${relative_path}/`);
      continue;
    }
    if (entry.isFile) yield relative_path;
  }
}

async function remove_if_present(path: URL): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function read_file_if_present(
  path: URL,
): Promise<Uint8Array | undefined> {
  try {
    return await Deno.readFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}
