declare const asset_id_brand: unique symbol;
declare const content_digest_brand: unique symbol;
declare const source_revision_brand: unique symbol;
declare const artifact_revision_brand: unique symbol;

export type AssetId<Kind extends string = string> = string & {
  readonly [asset_id_brand]: Kind;
};

export type ContentDigest = string & {
  readonly [content_digest_brand]: true;
};

export type SourceRevision = string & {
  readonly [source_revision_brand]: true;
};

export type ArtifactRevision = string & {
  readonly [artifact_revision_brand]: true;
};

export interface AssetRef<Kind extends string = string> {
  readonly id: AssetId<Kind>;
  readonly kind: Kind;
}

export type AssetPriority = "background" | "visible" | "blocking";

export function asset_id<Kind extends string>(value: string): AssetId<Kind> {
  return parse_nonempty(value, "asset id") as AssetId<Kind>;
}

export function asset_ref<Kind extends string>(
  id: AssetId<Kind>,
  kind: Kind,
): AssetRef<Kind> {
  return Object.freeze({
    id,
    kind: parse_nonempty(kind, "asset kind") as Kind,
  });
}

export function content_digest(value: string): ContentDigest {
  const parsed = value.toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(parsed)) {
    throw new Error(
      `asset digest ${
        JSON.stringify(value)
      } must use sha256:<64 lowercase hexadecimal characters>`,
    );
  }
  return parsed as ContentDigest;
}

export function source_revision(value: string): SourceRevision {
  return parse_nonempty(value, "asset source revision") as SourceRevision;
}

export function artifact_revision(value: string): ArtifactRevision {
  return parse_nonempty(value, "asset artifact revision") as ArtifactRevision;
}

function parse_nonempty(value: string, label: string): string {
  const parsed = value.trim();
  if (parsed.length === 0) {
    throw new Error(`${label} ${JSON.stringify(value)} cannot be empty`);
  }
  return parsed;
}
