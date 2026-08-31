import { AssetCache, type AssetLease, type AssetReplacement } from "./cache.ts";
import type { AssetId } from "./identity.ts";
import { type ArtifactReader, load_artifact } from "./load.ts";
import {
  type AssetManifest,
  type AssetManifestEntry,
  manifest_entry,
} from "./manifest.ts";

export interface AssetBundleLease {
  readonly assets: readonly AssetId[];
  readonly root: AssetId;
  read(id: AssetId): Uint8Array;
  release(): void;
}

export type AssetBundleLoadResult =
  | { readonly type: "ready"; readonly lease: AssetBundleLease }
  | { readonly type: "cancelled"; readonly root: AssetId }
  | {
    readonly type: "failed";
    readonly root: AssetId;
    readonly reason: string;
  };

export interface AssetBundleLoadRequest {
  readonly cache: AssetCache;
  readonly manifest: AssetManifest;
  readonly reader: ArtifactReader;
  readonly root: AssetId;
  readonly signal?: AbortSignal;
}

export async function replace_asset_bundle(
  request: AssetBundleLoadRequest,
): Promise<AssetBundleLoadResult> {
  const root_entry = manifest_entry(request.manifest, request.root);
  if (root_entry === undefined) {
    return {
      type: "failed",
      root: request.root,
      reason: `asset manifest does not contain bundle root ${
        JSON.stringify(request.root)
      }`,
    };
  }
  const entries = dependency_closure(request.manifest, root_entry);
  const signal = request.signal ?? new AbortController().signal;
  const results = await Promise.all(
    entries.map((entry) => load_artifact(entry, request.reader, signal)),
  );
  if (signal.aborted || results.some(({ type }) => type === "cancelled")) {
    return { type: "cancelled", root: request.root };
  }
  const failed = results.find((result) => result.type === "failed");
  if (failed?.type === "failed") {
    request.cache.record_failure(failed);
    return {
      type: "failed",
      root: request.root,
      reason: `asset bundle ${JSON.stringify(request.root)} could not load ${
        JSON.stringify(failed.id)
      } from ${JSON.stringify(failed.location)}: ${failed.reason}`,
    };
  }
  const replacements: AssetReplacement[] = [];
  for (const [index, result] of results.entries()) {
    if (result.type !== "ready") {
      throw new Error(
        `asset bundle ${
          JSON.stringify(request.root)
        } staged unexpected ${result.type} result after failure handling`,
      );
    }
    replacements.push({
      artifact: result,
      dependencies: entries[index].dependencies,
    });
  }
  const replacement = request.cache.replace(replacements);
  if (replacement.type === "rejected") {
    return {
      type: "failed",
      root: request.root,
      reason: `asset bundle ${
        JSON.stringify(request.root)
      } was not published: ${replacement.reason}`,
    };
  }
  const leases = new Map<AssetId, AssetLease>();
  for (const entry of entries) {
    const lease = request.cache.acquire(entry.id);
    if (lease === undefined) {
      for (const acquired of leases.values()) acquired.release();
      throw new Error(
        `asset cache lost ${
          JSON.stringify(entry.id)
        } immediately after publishing bundle ${JSON.stringify(request.root)}`,
      );
    }
    leases.set(entry.id, lease);
  }
  return {
    type: "ready",
    lease: create_bundle_lease(request.root, entries, leases),
  };
}

function dependency_closure(
  manifest: AssetManifest,
  root: AssetManifestEntry,
): readonly AssetManifestEntry[] {
  const entries_by_id = new Map(
    manifest.assets.map((entry) => [entry.id, entry] as const),
  );
  const included = new Set<AssetId>();
  const visit = (entry: AssetManifestEntry): void => {
    if (included.has(entry.id)) return;
    for (const dependency of entry.dependencies) {
      const dependency_entry = entries_by_id.get(dependency);
      if (dependency_entry === undefined) {
        throw new Error(
          `asset manifest lost dependency ${
            JSON.stringify(dependency)
          } required by ${JSON.stringify(entry.id)}`,
        );
      }
      visit(dependency_entry);
    }
    included.add(entry.id);
  };
  visit(root);
  const ordered: AssetManifestEntry[] = [];
  for (const id of manifest.dependency_order) {
    if (!included.has(id)) continue;
    const entry = entries_by_id.get(id);
    if (entry === undefined) {
      throw new Error(
        `asset manifest dependency order contains missing asset ${
          JSON.stringify(id)
        }`,
      );
    }
    ordered.push(entry);
  }
  return Object.freeze(ordered);
}

function create_bundle_lease(
  root: AssetId,
  entries: readonly AssetManifestEntry[],
  leases: ReadonlyMap<AssetId, AssetLease>,
): AssetBundleLease {
  let released = false;
  return {
    assets: Object.freeze(entries.map(({ id }) => id)),
    root,
    read(id) {
      if (released) {
        throw new Error(
          `asset bundle ${JSON.stringify(root)} was read after release`,
        );
      }
      const lease = leases.get(id);
      if (lease === undefined) {
        throw new Error(
          `asset ${JSON.stringify(id)} does not belong to bundle ${
            JSON.stringify(root)
          }`,
        );
      }
      return lease.read();
    },
    release() {
      if (released) {
        throw new Error(
          `asset bundle ${JSON.stringify(root)} was released more than once`,
        );
      }
      released = true;
      for (const lease of leases.values()) lease.release();
    },
  };
}
