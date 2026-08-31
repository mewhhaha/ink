import { replace_asset_bundle } from "@ink/assets/bundle.ts";
import { AssetCache } from "@ink/assets/cache.ts";
import { asset_id } from "@ink/assets/identity.ts";
import type { ArtifactReader } from "@ink/assets/load.ts";
import { manifest_entry, parse_asset_manifest } from "@ink/assets/manifest.ts";

const platformer_level_asset = asset_id("levels/first-steps.json");

export interface PlatformerAssetSource {
  readonly name: string;
  read_manifest(signal: AbortSignal): Promise<string>;
  readonly artifacts: ArtifactReader;
}

export async function load_platformer_level_asset(
  source: PlatformerAssetSource,
): Promise<string> {
  const signal = new AbortController().signal;
  const manifest_source = await source.read_manifest(signal);
  let manifest_value: unknown;
  try {
    manifest_value = JSON.parse(manifest_source);
  } catch (cause) {
    throw new Error(
      `platformer asset manifest ${
        JSON.stringify(source.name)
      } is not valid JSON`,
      { cause },
    );
  }
  const parsed = parse_asset_manifest(manifest_value, source.name);
  if (parsed.type === "invalid_manifest") {
    throw new Error(
      `platformer asset manifest ${JSON.stringify(parsed.source)} field ${
        JSON.stringify(parsed.field)
      } is invalid: ${parsed.reason}`,
    );
  }
  const level_entry = manifest_entry(parsed.manifest, platformer_level_asset);
  if (level_entry === undefined) {
    throw new Error(
      `platformer asset manifest ${
        JSON.stringify(source.name)
      } does not contain ${JSON.stringify(platformer_level_asset)}`,
    );
  }
  if (level_entry.kind !== "json") {
    throw new Error(
      `platformer level asset ${JSON.stringify(level_entry.id)} has kind ${
        JSON.stringify(level_entry.kind)
      }; expected "json"`,
    );
  }
  if (level_entry.dependencies.length !== 0) {
    throw new Error(
      `platformer level asset ${
        JSON.stringify(level_entry.id)
      } declares ${level_entry.dependencies.length} dependencies; expected a standalone Blot integer asset`,
    );
  }
  const expected_location = `assets/.ink/${
    level_entry.digest.slice("sha256:".length)
  }`;
  if (level_entry.location !== expected_location) {
    throw new Error(
      `platformer level asset ${JSON.stringify(level_entry.id)} location ${
        JSON.stringify(level_entry.location)
      } is not its digest-addressed location ${
        JSON.stringify(expected_location)
      }`,
    );
  }
  const loaded = await replace_asset_bundle({
    cache: new AssetCache(Math.max(1, level_entry.byte_size)),
    manifest: parsed.manifest,
    reader: source.artifacts,
    root: platformer_level_asset,
    signal,
  });
  if (loaded.type !== "ready") {
    throw new Error(
      `platformer level asset ${
        JSON.stringify(platformer_level_asset)
      } did not load: ${
        loaded.type === "failed" ? loaded.reason : "cancelled"
      }`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      loaded.lease.read(platformer_level_asset),
    );
  } catch (cause) {
    throw new Error(
      `platformer level asset ${
        JSON.stringify(platformer_level_asset)
      } is not UTF-8`,
      { cause },
    );
  } finally {
    loaded.lease.release();
  }
}

export function create_browser_platformer_asset_source(
  manifest_url: string,
): PlatformerAssetSource {
  const root = new URL("/", new URL(manifest_url, location.href));
  return {
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
          } returned HTTP ${response.status}`,
        );
      }
      return await response.text();
    },
    artifacts: {
      async read(artifact_location, signal) {
        const response = await fetch(
          new URL(artifact_location, root),
          { cache: "no-store", signal },
        );
        if (!response.ok) {
          throw new Error(
            `platformer asset ${
              JSON.stringify(artifact_location)
            } returned HTTP ${response.status}`,
          );
        }
        return new Uint8Array(await response.arrayBuffer());
      },
    },
  };
}
