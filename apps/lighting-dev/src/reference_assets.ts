import { replace_asset_bundle } from "@ink/assets/bundle.ts";
import { AssetCache } from "@ink/assets/cache.ts";
import { verify_digest } from "@ink/assets/digest.ts";
import {
  asset_id,
  content_digest,
  type ContentDigest,
} from "@ink/assets/identity.ts";
import type { ArtifactReader } from "@ink/assets/load.ts";
import {
  type AssetManifest,
  parse_asset_manifest,
} from "@ink/assets/manifest.ts";
import {
  decode_prepared_static_gltf_scene,
  type StaticGltfScene,
} from "@ink/assets/prepared_scene.ts";
import type { PreparedLightingReference } from "./scene.ts";

export interface LoadedReferenceAssets {
  readonly scene: StaticGltfScene;
  readonly source_materials: "embedded" | "upstream-omitted";
}

interface ReadyCatalogScene {
  readonly type: "ready";
  readonly root: string;
  readonly source: string;
  readonly source_materials: "embedded" | "upstream-omitted";
}

type CatalogScene =
  | ReadyCatalogScene
  | {
    readonly type: "unavailable";
    readonly reason: string;
    readonly source: string;
  };

interface LightingAssetCatalog {
  readonly manifest: {
    readonly byte_size: number;
    readonly digest: ContentDigest;
    readonly location: string;
  };
  readonly scenes: Readonly<Record<PreparedLightingReference, CatalogScene>>;
  readonly version: 1;
}

export class LightingReferenceAssets {
  readonly #cache: AssetCache;
  readonly #catalog: LightingAssetCatalog;
  readonly #manifest: AssetManifest;
  readonly #reader: ArtifactReader;

  private constructor(
    catalog: LightingAssetCatalog,
    manifest: AssetManifest,
    reader: ArtifactReader,
  ) {
    const manifest_bytes = manifest.assets.reduce(
      (total, entry) => total + entry.byte_size,
      0,
    );
    const cache_budget = Math.max(1, manifest_bytes * 2);
    if (!Number.isSafeInteger(cache_budget)) {
      throw new Error(
        `lighting asset manifest needs unsafe cache budget ${cache_budget} bytes`,
      );
    }
    this.#cache = new AssetCache(cache_budget);
    this.#catalog = catalog;
    this.#manifest = manifest;
    this.#reader = reader;
  }

  static async create(
    reader: ArtifactReader = browser_artifact_reader,
  ): Promise<LightingReferenceAssets> {
    const signal = new AbortController().signal;
    const catalog_bytes = await reader.read("/prepared/catalog.json", signal);
    const catalog = parse_catalog(catalog_bytes, "/prepared/catalog.json");
    const manifest_bytes = await reader.read(catalog.manifest.location, signal);
    if (manifest_bytes.length !== catalog.manifest.byte_size) {
      throw new Error(
        `lighting asset manifest ${
          JSON.stringify(catalog.manifest.location)
        } has ${manifest_bytes.length} bytes; catalog declares ${catalog.manifest.byte_size}`,
      );
    }
    const verified = await verify_digest(
      manifest_bytes,
      catalog.manifest.digest,
    );
    if (verified.type === "digest_mismatch") {
      throw new Error(
        `lighting asset manifest ${
          JSON.stringify(catalog.manifest.location)
        } has digest ${verified.actual}; catalog declares ${verified.expected}`,
      );
    }
    const parsed = parse_asset_manifest(
      parse_json(manifest_bytes, catalog.manifest.location),
      catalog.manifest.location,
    );
    if (parsed.type === "invalid_manifest") {
      throw new Error(
        `lighting asset manifest ${JSON.stringify(parsed.source)} field ${
          JSON.stringify(parsed.field)
        } is invalid: ${parsed.reason}`,
      );
    }
    return new LightingReferenceAssets(catalog, parsed.manifest, reader);
  }

  async load(
    reference: PreparedLightingReference,
  ): Promise<LoadedReferenceAssets> {
    const catalog_scene = this.#catalog.scenes[reference];
    if (catalog_scene.type === "unavailable") {
      throw new Error(
        `${reference} lighting reference is unavailable: ${catalog_scene.reason}`,
      );
    }
    const root = asset_id(catalog_scene.root);
    const loaded = await replace_asset_bundle({
      cache: this.#cache,
      manifest: this.#manifest,
      reader: this.#reader,
      root,
    });
    if (loaded.type !== "ready") {
      throw new Error(
        `${reference} lighting reference ${loaded.type}: ${
          loaded.type === "failed" ? loaded.reason : "load was cancelled"
        }`,
      );
    }
    try {
      return Object.freeze({
        scene: decode_prepared_static_gltf_scene(
          loaded.lease.read(root),
          catalog_scene.source,
          (id) => loaded.lease.read(id),
        ),
        source_materials: catalog_scene.source_materials,
      });
    } finally {
      loaded.lease.release();
    }
  }
}

const browser_artifact_reader: ArtifactReader = {
  async read(location, signal) {
    const request_location = location.startsWith("/")
      ? location
      : `/${location}`;
    const response = await fetch(request_location, { signal });
    if (!response.ok) {
      throw new Error(
        `lighting artifact ${
          JSON.stringify(location)
        } returned HTTP ${response.status}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  },
};

function parse_catalog(
  bytes: Uint8Array,
  source: string,
): LightingAssetCatalog {
  const record = expect_record(parse_json(bytes, source), "$", source);
  if (record.version !== 1) {
    throw new Error(
      `lighting asset catalog ${JSON.stringify(source)} version ${
        JSON.stringify(record.version)
      } is unsupported; expected 1`,
    );
  }
  const manifest = expect_record(record.manifest, "$.manifest", source);
  const scenes = expect_record(record.scenes, "$.scenes", source);
  return Object.freeze({
    manifest: Object.freeze({
      byte_size: nonnegative_integer(
        manifest.byte_size,
        "$.manifest.byte_size",
        source,
      ),
      digest: content_digest(
        nonempty_string(manifest.digest, "$.manifest.digest", source),
      ),
      location: nonempty_string(
        manifest.location,
        "$.manifest.location",
        source,
      ),
    }),
    scenes: Object.freeze({
      bistro: parse_catalog_scene(scenes.bistro, "$.scenes.bistro", source),
      caldera: parse_catalog_scene(
        scenes.caldera,
        "$.scenes.caldera",
        source,
      ),
      "fog-room": parse_catalog_scene(
        scenes["fog-room"],
        '$.scenes["fog-room"]',
        source,
      ),
    }),
    version: 1,
  });
}

function parse_catalog_scene(
  value: unknown,
  field: string,
  source: string,
): CatalogScene {
  const record = expect_record(value, field, source);
  const type = nonempty_string(record.type, `${field}.type`, source);
  if (type === "unavailable") {
    return Object.freeze({
      type,
      reason: nonempty_string(record.reason, `${field}.reason`, source),
      source: nonempty_string(record.source, `${field}.source`, source),
    });
  }
  if (type !== "ready") {
    throw new Error(
      `lighting asset catalog ${
        JSON.stringify(source)
      } field ${field}.type is ${
        JSON.stringify(type)
      }; expected "ready" or "unavailable"`,
    );
  }
  const source_materials = nonempty_string(
    record.source_materials,
    `${field}.source_materials`,
    source,
  );
  if (
    source_materials !== "embedded" && source_materials !== "upstream-omitted"
  ) {
    throw new Error(
      `lighting asset catalog ${
        JSON.stringify(source)
      } field ${field}.source_materials is ${
        JSON.stringify(source_materials)
      }; expected "embedded" or "upstream-omitted"`,
    );
  }
  return Object.freeze({
    type,
    root: nonempty_string(record.root, `${field}.root`, source),
    source: nonempty_string(record.source, `${field}.source`, source),
    source_materials,
  });
}

function parse_json(bytes: Uint8Array, source: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error(
      `lighting asset ${JSON.stringify(source)} is not valid UTF-8 JSON`,
      { cause },
    );
  }
}

function expect_record(
  value: unknown,
  field: string,
  source: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `lighting asset ${
        JSON.stringify(source)
      } field ${field} must be an object`,
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

function nonempty_string(
  value: unknown,
  field: string,
  source: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `lighting asset ${
        JSON.stringify(source)
      } field ${field} must be a nonempty string; received ${
        JSON.stringify(value)
      }`,
    );
  }
  return value.trim();
}

function nonnegative_integer(
  value: unknown,
  field: string,
  source: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(
      `lighting asset ${
        JSON.stringify(source)
      } field ${field} must be a nonnegative safe integer; received ${
        JSON.stringify(value)
      }`,
    );
  }
  return value as number;
}
