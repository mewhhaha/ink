import { replace_asset_bundle } from "@ink/assets/bundle.ts";
import { AssetCache } from "@ink/assets/cache.ts";
import { verify_digest } from "@ink/assets/digest.ts";
import {
  type AssetId,
  content_digest,
  type ContentDigest,
} from "@ink/assets/identity.ts";
import type { ArtifactReader } from "@ink/assets/load.ts";
import {
  type AssetManifest,
  parse_asset_manifest,
} from "@ink/assets/manifest.ts";
import { decode_prepared_static_gltf_scene } from "@ink/assets/prepared_scene.ts";
import type { SceneResource } from "@ink/blot/protocol.ts";
import {
  adventure_render_bundle_asset,
  parse_adventure_render_asset_catalog,
} from "../prepared_assets.ts";

export interface SceneRenderAssets {
  readonly meshes: readonly {
    readonly id: number;
    readonly asset: AssetId<"mesh">;
    readonly indices: Uint32Array;
    readonly vertices: Float32Array;
  }[];
  readonly textures: readonly {
    readonly id: number;
    readonly asset: AssetId<"texture">;
    readonly bytes: Uint8Array;
    readonly mime_type: string;
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

  async read(asset: AssetId): Promise<Uint8Array> {
    const signal = new AbortController().signal;
    const manifest = await this.#read_manifest(signal);
    const loaded = await replace_asset_bundle({
      cache: this.#cache,
      manifest,
      reader: this.#source.artifacts,
      root: asset,
      signal,
    });
    if (loaded.type !== "ready") {
      throw new Error(
        `scene asset ${JSON.stringify(asset)} did not load: ${
          loaded.type === "failed" ? loaded.reason : "cancelled"
        }`,
      );
    }
    try {
      return loaded.lease.read(asset);
    } finally {
      loaded.lease.release();
    }
  }

  async replace(
    resources: readonly SceneResource[],
  ): Promise<SceneRenderAssets> {
    const signal = new AbortController().signal;
    const manifest = await this.#read_manifest(signal);
    const loaded = await replace_asset_bundle({
      cache: this.#cache,
      manifest,
      reader: this.#source.artifacts,
      root: adventure_render_bundle_asset,
      signal,
    });
    if (loaded.type !== "ready") {
      throw new Error(
        `adventure render asset bundle did not load: ${
          loaded.type === "failed" ? loaded.reason : "cancelled"
        }`,
      );
    }
    try {
      const catalog = parse_adventure_render_asset_catalog(
        loaded.lease.read(adventure_render_bundle_asset),
        adventure_render_bundle_asset,
      );
      const scene = decode_prepared_static_gltf_scene(
        loaded.lease.read(catalog.scene),
        catalog.scene,
        (id) => loaded.lease.read(id),
      );
      const meshes_by_id = new Map<string, (typeof scene.meshes)[number]>();
      for (const mesh of scene.meshes) {
        if (meshes_by_id.has(mesh.id)) {
          throw new Error(
            `adventure prepared scene repeats mesh ${JSON.stringify(mesh.id)}`,
          );
        }
        meshes_by_id.set(mesh.id, mesh);
      }
      const textures_by_id = new Map<
        string,
        (typeof scene.textures)[number]
      >();
      for (const texture of scene.textures) {
        if (textures_by_id.has(texture.id)) {
          throw new Error(
            `adventure prepared scene repeats texture ${
              JSON.stringify(texture.id)
            }`,
          );
        }
        textures_by_id.set(texture.id, texture);
      }
      const meshes = [];
      const textures = [];
      for (const resource of resources) {
        const mapped = catalog.resources.find(({ asset }) =>
          asset === resource.asset
        );
        if (mapped === undefined) {
          throw new Error(
            `scene ${resource.type} ${resource.id} references unmapped logical asset ${
              JSON.stringify(resource.asset)
            }`,
          );
        }
        if (mapped.type !== resource.type) {
          throw new Error(
            `scene ${resource.type} ${resource.id} logical asset ${
              JSON.stringify(resource.asset)
            } maps to incompatible ${mapped.type} resource`,
          );
        }
        if (resource.type === "mesh") {
          const mesh = meshes_by_id.get(mapped.prepared_id);
          if (mesh === undefined) {
            throw new Error(
              `scene mesh ${resource.id} logical asset ${
                JSON.stringify(resource.asset)
              } maps to missing prepared mesh ${
                JSON.stringify(mapped.prepared_id)
              }`,
            );
          }
          meshes.push(Object.freeze({
            id: resource.id,
            asset: resource.asset,
            indices: mesh.indices.slice(),
            vertices: mesh.vertices.slice(),
          }));
          continue;
        }
        const texture = textures_by_id.get(mapped.prepared_id);
        if (texture === undefined) {
          throw new Error(
            `scene texture ${resource.id} logical asset ${
              JSON.stringify(resource.asset)
            } maps to missing prepared texture ${
              JSON.stringify(mapped.prepared_id)
            }`,
          );
        }
        textures.push(Object.freeze({
          id: resource.id,
          asset: resource.asset,
          bytes: texture.bytes.slice(),
          mime_type: texture.mime_type,
        }));
      }
      return Object.freeze({
        meshes: Object.freeze(meshes),
        textures: Object.freeze(textures),
      });
    } finally {
      loaded.lease.release();
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
        const bytes = new Uint8Array(await response.arrayBuffer());
        const expected = digest_keyed_artifact_revision(artifact_location);
        const verified = await verify_digest(bytes, expected);
        if (verified.type === "digest_mismatch") {
          throw new Error(
            `scene asset artifact ${
              JSON.stringify(artifact_location)
            } digest ${verified.actual} does not match digest-keyed location ${verified.expected}`,
          );
        }
        return bytes;
      },
    },
  });
}

function digest_keyed_artifact_revision(location: string): ContentDigest {
  const match = /^assets\/\.ink\/([0-9a-f]{64})$/.exec(location);
  if (match === null) {
    throw new Error(
      `scene asset artifact location ${
        JSON.stringify(location)
      } is not digest-keyed under assets/.ink`,
    );
  }
  return content_digest(`sha256:${match[1]}`);
}
