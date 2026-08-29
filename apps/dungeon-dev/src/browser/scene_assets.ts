import { AssetCache } from "@ink/assets/cache.ts";
import type { ArtifactReader } from "@ink/assets/load.ts";
import { load_artifact } from "@ink/assets/load.ts";
import {
  type AssetManifest,
  type AssetManifestEntry,
  manifest_entry,
  parse_asset_manifest,
} from "@ink/assets/manifest.ts";
import type { AssetId } from "@ink/assets/identity.ts";
import type { SceneResource } from "@ink/blot/protocol.ts";

export interface SceneAssetBytes {
  readonly meshes: readonly {
    readonly id: number;
    readonly asset: AssetId<"mesh">;
    readonly bytes: Uint8Array;
  }[];
  readonly textures: readonly {
    readonly id: number;
    readonly asset: AssetId<"texture">;
    readonly bytes: Uint8Array;
  }[];
}

export interface SceneAssetSource {
  readonly name: string;
  read_manifest(signal: AbortSignal): Promise<string>;
  readonly artifacts: ArtifactReader;
}

export class SceneAssetStore {
  readonly #source: SceneAssetSource;
  readonly #cache: AssetCache;

  constructor(source: SceneAssetSource, maximum_bytes = 256 * 1024 * 1024) {
    this.#source = source;
    this.#cache = new AssetCache(maximum_bytes);
  }

  async replace(resources: readonly SceneResource[]): Promise<SceneAssetBytes> {
    const signal = new AbortController().signal;
    const manifest = await this.#read_manifest(signal);
    const entries = resources.map((resource) => {
      const entry = manifest_entry(manifest, resource.asset);
      if (entry === undefined) {
        throw new Error(
          `scene ${resource.type} ${resource.id} references missing asset ${
            JSON.stringify(resource.asset)
          }`,
        );
      }
      expect_resource_kind(resource, entry);
      return entry;
    });
    const required = dependency_closure(manifest, entries);
    const replacements = [];
    for (const entry of required) {
      const current = this.#cache.state(entry.id);
      if (
        current.type === "ready" &&
        current.revision === entry.artifact_revision
      ) {
        continue;
      }
      const loaded = await load_artifact(entry, this.#source.artifacts, signal);
      if (loaded.type !== "ready") {
        if (loaded.type === "failed") this.#cache.record_failure(loaded);
        throw new Error(
          `scene asset ${JSON.stringify(entry.id)} did not load: ${
            loaded.type === "failed" ? loaded.reason : "cancelled"
          }`,
        );
      }
      replacements.push({ artifact: loaded, dependencies: entry.dependencies });
    }
    if (replacements.length > 0) {
      const replaced = this.#cache.replace(replacements);
      if (replaced.type === "rejected") {
        throw new Error(
          `scene asset replacement was rejected: ${replaced.reason}`,
        );
      }
    }

    const leases = resources.map((resource) => {
      const lease = this.#cache.acquire(resource.asset);
      if (lease === undefined) {
        throw new Error(
          `scene asset ${
            JSON.stringify(resource.asset)
          } is unavailable after replacement`,
        );
      }
      return { resource, lease };
    });
    try {
      return Object.freeze({
        meshes: Object.freeze(
          leases.flatMap(({ resource, lease }) =>
            resource.type === "mesh"
              ? [{
                id: resource.id,
                asset: resource.asset,
                bytes: lease.read(),
              }]
              : []
          ),
        ),
        textures: Object.freeze(
          leases.flatMap(({ resource, lease }) =>
            resource.type === "texture"
              ? [{
                id: resource.id,
                asset: resource.asset,
                bytes: lease.read(),
              }]
              : []
          ),
        ),
      });
    } finally {
      for (const { lease } of leases) lease.release();
    }
  }

  async #read_manifest(signal: AbortSignal): Promise<AssetManifest> {
    const source = await this.#source.read_manifest(signal);
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (cause) {
      throw new Error(
        `scene asset manifest ${
          JSON.stringify(this.#source.name)
        } is not valid JSON`,
        { cause },
      );
    }
    const parsed = parse_asset_manifest(value, this.#source.name);
    if (parsed.type === "invalid_manifest") {
      throw new Error(
        `scene asset manifest ${JSON.stringify(parsed.source)} field ${
          JSON.stringify(parsed.field)
        } is invalid: ${parsed.reason}`,
      );
    }
    return parsed.manifest;
  }
}

export function create_browser_scene_asset_store(
  manifest_url: string,
): SceneAssetStore {
  const root = new URL("/", new URL(manifest_url, location.href));
  return new SceneAssetStore({
    name: manifest_url,
    async read_manifest(signal) {
      const response = await fetch(manifest_url, { cache: "no-store", signal });
      if (!response.ok) {
        throw new Error(
          `scene asset manifest ${
            JSON.stringify(manifest_url)
          } returned ${response.status}`,
        );
      }
      return await response.text();
    },
    artifacts: {
      async read(artifact_location, signal) {
        const url = new URL(artifact_location, root).href;
        const response = await fetch(url, { cache: "no-store", signal });
        if (!response.ok) {
          throw new Error(
            `scene asset artifact ${
              JSON.stringify(artifact_location)
            } returned ${response.status}`,
          );
        }
        return new Uint8Array(await response.arrayBuffer());
      },
    },
  });
}

function dependency_closure(
  manifest: AssetManifest,
  roots: readonly AssetManifestEntry[],
): readonly AssetManifestEntry[] {
  const required = new Set<AssetId>(roots.map(({ id }) => id));
  let discovered = true;
  while (discovered) {
    discovered = false;
    for (const entry of manifest.assets) {
      if (!required.has(entry.id)) continue;
      for (const dependency of entry.dependencies) {
        if (required.has(dependency)) continue;
        required.add(dependency);
        discovered = true;
      }
    }
  }
  return manifest.dependency_order.flatMap((id) => {
    if (!required.has(id)) return [];
    const entry = manifest_entry(manifest, id);
    if (entry === undefined) {
      throw new Error(
        `scene asset manifest dependency order references missing asset ${
          JSON.stringify(id)
        }`,
      );
    }
    return [entry];
  });
}

function expect_resource_kind(
  resource: SceneResource,
  entry: AssetManifestEntry,
): void {
  const supported = resource.type === "mesh"
    ? new Set(["obj"])
    : new Set(["png", "jpg", "jpeg", "webp"]);
  if (supported.has(entry.kind)) return;
  throw new Error(
    `scene ${resource.type} ${resource.id} asset ${
      JSON.stringify(entry.id)
    } has incompatible kind ${JSON.stringify(entry.kind)}`,
  );
}
