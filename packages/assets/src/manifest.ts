import {
  artifact_revision,
  type ArtifactRevision,
  asset_id,
  type AssetId,
  content_digest,
  type ContentDigest,
  source_revision,
  type SourceRevision,
} from "./identity.ts";

export const asset_manifest_version = 1 as const;

export interface AssetVariant {
  readonly artifact_revision: ArtifactRevision;
  readonly byte_size: number;
  readonly digest: ContentDigest;
  readonly location: string;
}

export interface AssetManifestEntry {
  readonly id: AssetId;
  readonly kind: string;
  readonly source_revision: SourceRevision;
  readonly artifact_revision: ArtifactRevision;
  readonly byte_size: number;
  readonly digest: ContentDigest;
  readonly location: string;
  readonly dependencies: readonly AssetId[];
  readonly variants: Readonly<Record<string, AssetVariant>>;
}

export interface AssetManifest {
  readonly version: typeof asset_manifest_version;
  readonly assets: readonly AssetManifestEntry[];
  readonly dependency_order: readonly AssetId[];
}

export interface ManifestFailure {
  readonly type: "invalid_manifest";
  readonly source: string;
  readonly field: string;
  readonly asset_id?: string;
  readonly reason: string;
}

export type ManifestParseResult =
  | { readonly type: "ready"; readonly manifest: AssetManifest }
  | ManifestFailure;

interface ManifestIssue {
  readonly field: string;
  readonly asset_id?: string;
  readonly reason: string;
}

export function parse_asset_manifest(
  value: unknown,
  source: string,
): ManifestParseResult {
  const parsed_source = source.trim();
  if (parsed_source.length === 0) {
    return failure(
      source,
      "source",
      undefined,
      "manifest source cannot be empty",
    );
  }

  try {
    const manifest = parse_manifest(value);
    return { type: "ready", manifest };
  } catch (error) {
    if (is_manifest_issue(error)) {
      return failure(
        parsed_source,
        error.field,
        error.asset_id,
        error.reason,
      );
    }
    throw error;
  }
}

export function manifest_entry(
  manifest: AssetManifest,
  id: AssetId,
): AssetManifestEntry | undefined {
  return manifest.assets.find((entry) => entry.id === id);
}

function parse_manifest(value: unknown): AssetManifest {
  const record = expect_record(value, "$", undefined);
  if (record.version !== asset_manifest_version) {
    issue(
      "$.version",
      undefined,
      `manifest version ${
        JSON.stringify(record.version)
      } is not supported; expected ${asset_manifest_version}`,
    );
  }
  if (!Array.isArray(record.assets)) {
    issue("$.assets", undefined, "manifest assets must be an array");
  }

  const entries = record.assets.map((entry, index) =>
    parse_entry(entry, `$.assets[${index}]`)
  ).sort((left, right) => left.id.localeCompare(right.id));
  const entries_by_id = new Map<AssetId, AssetManifestEntry>();
  for (const entry of entries) {
    if (entries_by_id.has(entry.id)) {
      issue(
        "$.assets",
        entry.id,
        `asset ${JSON.stringify(entry.id)} appears more than once`,
      );
    }
    entries_by_id.set(entry.id, entry);
  }

  for (const entry of entries) {
    for (const dependency of entry.dependencies) {
      if (!entries_by_id.has(dependency)) {
        issue(
          "dependencies",
          entry.id,
          `asset ${JSON.stringify(entry.id)} depends on missing asset ${
            JSON.stringify(dependency)
          }`,
        );
      }
    }
  }

  return {
    version: asset_manifest_version,
    assets: entries,
    dependency_order: resolve_dependency_order(entries_by_id),
  };
}

function parse_entry(value: unknown, field: string): AssetManifestEntry {
  const record = expect_record(value, field, undefined);
  const raw_id = expect_string(record.id, `${field}.id`, undefined);
  const id = parse_with_evidence(() => asset_id(raw_id), `${field}.id`, raw_id);
  const kind = expect_nonempty_string(record.kind, `${field}.kind`, id);
  const dependencies = parse_dependencies(record.dependencies, field, id);
  const variants = parse_variants(record.variants, field, id);
  return {
    id,
    kind,
    source_revision: parse_with_evidence(
      () =>
        source_revision(
          expect_string(record.source_revision, `${field}.source_revision`, id),
        ),
      `${field}.source_revision`,
      id,
    ),
    artifact_revision: parse_with_evidence(
      () =>
        artifact_revision(
          expect_string(
            record.artifact_revision,
            `${field}.artifact_revision`,
            id,
          ),
        ),
      `${field}.artifact_revision`,
      id,
    ),
    byte_size: expect_nonnegative_integer(
      record.byte_size,
      `${field}.byte_size`,
      id,
    ),
    digest: parse_with_evidence(
      () => content_digest(expect_string(record.digest, `${field}.digest`, id)),
      `${field}.digest`,
      id,
    ),
    location: expect_nonempty_string(record.location, `${field}.location`, id),
    dependencies,
    variants,
  };
}

function parse_dependencies(
  value: unknown,
  field: string,
  owner: AssetId,
): readonly AssetId[] {
  if (!Array.isArray(value)) {
    issue(
      `${field}.dependencies`,
      owner,
      "asset dependencies must be an array",
    );
  }
  const dependencies = value.map((dependency, index) => {
    const raw = expect_string(
      dependency,
      `${field}.dependencies[${index}]`,
      owner,
    );
    return parse_with_evidence(
      () => asset_id(raw),
      `${field}.dependencies[${index}]`,
      owner,
    );
  }).sort((left, right) => left.localeCompare(right));
  const duplicate = dependencies.find((dependency, index) =>
    dependency === dependencies[index - 1]
  );
  if (duplicate !== undefined) {
    issue(
      `${field}.dependencies`,
      owner,
      `asset ${JSON.stringify(owner)} repeats dependency ${
        JSON.stringify(duplicate)
      }`,
    );
  }
  return dependencies;
}

function parse_variants(
  value: unknown,
  field: string,
  owner: AssetId,
): Readonly<Record<string, AssetVariant>> {
  const record = expect_record(value, `${field}.variants`, owner);
  const variants: Record<string, AssetVariant> = {};
  for (const name of Object.keys(record).sort()) {
    const variant_field = `${field}.variants.${name}`;
    const variant = expect_record(record[name], variant_field, owner);
    const parsed_name = name.trim();
    if (parsed_name.length === 0) {
      issue(variant_field, owner, "asset variant name cannot be empty");
    }
    variants[parsed_name] = {
      artifact_revision: parse_with_evidence(
        () =>
          artifact_revision(
            expect_string(
              variant.artifact_revision,
              `${variant_field}.artifact_revision`,
              owner,
            ),
          ),
        `${variant_field}.artifact_revision`,
        owner,
      ),
      byte_size: expect_nonnegative_integer(
        variant.byte_size,
        `${variant_field}.byte_size`,
        owner,
      ),
      digest: parse_with_evidence(
        () =>
          content_digest(
            expect_string(variant.digest, `${variant_field}.digest`, owner),
          ),
        `${variant_field}.digest`,
        owner,
      ),
      location: expect_nonempty_string(
        variant.location,
        `${variant_field}.location`,
        owner,
      ),
    };
  }
  return variants;
}

function resolve_dependency_order(
  entries: ReadonlyMap<AssetId, AssetManifestEntry>,
): readonly AssetId[] {
  const visiting = new Set<AssetId>();
  const visited = new Set<AssetId>();
  const path: AssetId[] = [];
  const order: AssetId[] = [];

  const visit = (id: AssetId) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycle_start = path.indexOf(id);
      const cycle = [...path.slice(cycle_start), id];
      issue(
        "dependencies",
        id,
        `asset dependency cycle is ${
          cycle.map((entry) => JSON.stringify(entry)).join(" -> ")
        }`,
      );
    }
    visiting.add(id);
    path.push(id);
    for (const dependency of entries.get(id)!.dependencies) visit(dependency);
    path.pop();
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };

  for (const id of entries.keys()) visit(id);
  return order;
}

function expect_record(
  value: unknown,
  field: string,
  owner: string | undefined,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issue(field, owner, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expect_string(
  value: unknown,
  field: string,
  owner: string | undefined,
): string {
  if (typeof value !== "string") {
    issue(
      field,
      owner,
      `${field} must be a string; received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function expect_nonempty_string(
  value: unknown,
  field: string,
  owner: string | undefined,
): string {
  const parsed = expect_string(value, field, owner).trim();
  if (parsed.length === 0) issue(field, owner, `${field} cannot be empty`);
  return parsed;
}

function expect_nonnegative_integer(
  value: unknown,
  field: string,
  owner: string | undefined,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    issue(
      field,
      owner,
      `${field} ${JSON.stringify(value)} must be a nonnegative safe integer`,
    );
  }
  return value as number;
}

function parse_with_evidence<T>(
  parse: () => T,
  field: string,
  owner: string | undefined,
): T {
  try {
    return parse();
  } catch (error) {
    issue(field, owner, error instanceof Error ? error.message : String(error));
  }
}

function issue(
  field: string,
  asset_id: string | undefined,
  reason: string,
): never {
  throw { field, asset_id, reason } satisfies ManifestIssue;
}

function is_manifest_issue(value: unknown): value is ManifestIssue {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.field === "string" && typeof record.reason === "string";
}

function failure(
  source: string,
  field: string,
  asset_id: string | undefined,
  reason: string,
): ManifestFailure {
  return {
    type: "invalid_manifest",
    source,
    field,
    ...(asset_id === undefined ? {} : { asset_id }),
    reason,
  };
}
