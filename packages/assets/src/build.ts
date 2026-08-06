import { digest_bytes } from "./digest.ts";
import {
  artifact_revision,
  asset_id,
  type AssetId,
  source_revision,
} from "./identity.ts";
import {
  type AssetManifest,
  type AssetManifestEntry,
  parse_asset_manifest,
} from "./manifest.ts";

export interface AuthoredAsset {
  readonly id: string;
  readonly kind: string;
  readonly bytes: Uint8Array;
  readonly dependencies?: readonly string[];
}

export interface DerivedArtifact {
  readonly id: AssetId;
  readonly location: string;
  readonly bytes: Uint8Array;
}

export interface AssetBuild {
  readonly manifest: AssetManifest;
  readonly artifacts: readonly DerivedArtifact[];
}

export async function build_asset_manifest(
  assets: readonly AuthoredAsset[],
  manifest_source: string,
): Promise<AssetBuild> {
  const entries: AssetManifestEntry[] = [];
  const artifacts: DerivedArtifact[] = [];
  for (
    const authored of [...assets].sort((left, right) =>
      left.id.localeCompare(right.id)
    )
  ) {
    const id = asset_id(authored.id);
    const digest = await digest_bytes(authored.bytes);
    const digest_value = digest.slice("sha256:".length);
    const location = `assets/.ink/${digest_value}`;
    const bytes = new Uint8Array(authored.bytes);
    entries.push({
      id,
      kind: authored.kind,
      source_revision: source_revision(digest),
      artifact_revision: artifact_revision(digest),
      byte_size: bytes.length,
      digest,
      location,
      dependencies: (authored.dependencies ?? []).map((dependency) =>
        asset_id(dependency)
      ),
      variants: {},
    });
    artifacts.push({ id, location, bytes });
  }

  const parsed = parse_asset_manifest({
    version: 1,
    assets: entries,
  }, manifest_source);
  if (parsed.type === "invalid_manifest") {
    throw new Error(
      `asset manifest ${JSON.stringify(parsed.source)} field ${
        JSON.stringify(parsed.field)
      } is invalid: ${parsed.reason}`,
    );
  }
  return { manifest: parsed.manifest, artifacts };
}

export function serialize_asset_manifest(manifest: AssetManifest): string {
  return `${
    JSON.stringify(
      {
        version: manifest.version,
        assets: manifest.assets.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          source_revision: entry.source_revision,
          artifact_revision: entry.artifact_revision,
          byte_size: entry.byte_size,
          digest: entry.digest,
          location: entry.location,
          dependencies: entry.dependencies,
          variants: entry.variants,
        })),
      },
      null,
      2,
    )
  }\n`;
}
