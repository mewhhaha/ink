import { AssetCache } from "@ink/assets/cache.ts";
import { type ArtifactReader, load_artifact } from "@ink/assets/load.ts";
import { manifest_entry, parse_asset_manifest } from "@ink/assets/manifest.ts";
import { parse_obj_model } from "@ink/assets/mesh.ts";
import type { SceneResource } from "@ink/blot/protocol.ts";
import type { PreviewMesh } from "@ink/rendering/compatibility_renderer.ts";

export interface PlatformerAssetSource {
  readonly name: string;
  read_manifest(signal: AbortSignal): Promise<string>;
  readonly artifacts: ArtifactReader;
}

export class PlatformerSceneAssetStore {
  readonly #source: PlatformerAssetSource;
  readonly #cache = new AssetCache(16 * 1024 * 1024);

  constructor(source: PlatformerAssetSource) {
    this.#source = source;
  }

  async replace(resource: SceneResource): Promise<PreviewMesh> {
    if (resource.type !== "mesh") {
      throw new Error(
        `platformer resource ${resource.id} has unsupported type ${
          JSON.stringify(resource.type)
        }`,
      );
    }
    const signal = new AbortController().signal;
    const manifest = await this.#read_manifest(signal);
    const entry = manifest_entry(manifest, resource.asset);
    if (entry === undefined) {
      throw new Error(
        `platformer mesh ${resource.id} references missing asset ${
          JSON.stringify(resource.asset)
        }`,
      );
    }
    if (entry.kind !== "obj") {
      throw new Error(
        `platformer mesh ${resource.id} asset ${
          JSON.stringify(resource.asset)
        } has kind ${JSON.stringify(entry.kind)} instead of "obj"`,
      );
    }
    const current = this.#cache.state(entry.id);
    if (
      current.type !== "ready" || current.revision !== entry.artifact_revision
    ) {
      const loaded = await load_artifact(entry, this.#source.artifacts, signal);
      if (loaded.type !== "ready") {
        throw new Error(
          `platformer mesh ${JSON.stringify(entry.id)} did not load: ${
            loaded.type === "failed" ? loaded.reason : "cancelled"
          }`,
        );
      }
      const replacement = this.#cache.replace([{
        artifact: loaded,
        dependencies: entry.dependencies,
      }]);
      if (replacement.type === "rejected") {
        throw new Error(
          `platformer mesh ${
            JSON.stringify(entry.id)
          } replacement was rejected: ${replacement.reason}`,
        );
      }
    }
    const lease = this.#cache.acquire(entry.id);
    if (lease === undefined) {
      throw new Error(
        `platformer mesh ${
          JSON.stringify(entry.id)
        } is unavailable after replacement`,
      );
    }
    try {
      return {
        id: resource.id,
        model: parse_obj_model(
          new TextDecoder("utf-8", { fatal: true }).decode(lease.read()),
          entry.id,
        ),
      };
    } finally {
      lease.release();
    }
  }

  async #read_manifest(signal: AbortSignal) {
    const source = await this.#source.read_manifest(signal);
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (cause) {
      throw new Error(
        `platformer asset manifest ${
          JSON.stringify(this.#source.name)
        } is not valid JSON`,
        { cause },
      );
    }
    const parsed = parse_asset_manifest(value, this.#source.name);
    if (parsed.type === "invalid_manifest") {
      throw new Error(
        `platformer asset manifest ${JSON.stringify(parsed.source)} field ${
          JSON.stringify(parsed.field)
        } is invalid: ${parsed.reason}`,
      );
    }
    return parsed.manifest;
  }
}

export function create_browser_platformer_assets(
  manifest_url: string,
): PlatformerSceneAssetStore {
  const root = new URL("/", new URL(manifest_url, location.href));
  return new PlatformerSceneAssetStore({
    name: manifest_url,
    async read_manifest(signal) {
      const response = await fetch(manifest_url, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        throw new Error(
          `platformer asset manifest ${
            JSON.stringify(manifest_url)
          } returned ${response.status}`,
        );
      }
      return await response.text();
    },
    artifacts: {
      async read(location, signal) {
        const response = await fetch(new URL(location, root), {
          cache: "no-store",
          signal,
        });
        if (!response.ok) {
          throw new Error(
            `platformer asset artifact ${
              JSON.stringify(location)
            } returned ${response.status}`,
          );
        }
        return new Uint8Array(await response.arrayBuffer());
      },
    },
  });
}
