import type { ArtifactRevision, AssetId } from "./identity.ts";
import type { AssetManifestEntry } from "./manifest.ts";
import { verify_digest } from "./digest.ts";

export interface ArtifactReader {
  read(location: string, signal: AbortSignal): Promise<Uint8Array>;
}

export type ArtifactLoadResult =
  | {
    readonly type: "ready";
    readonly id: AssetId;
    readonly revision: ArtifactRevision;
    readonly bytes: Uint8Array;
  }
  | {
    readonly type: "cancelled";
    readonly id: AssetId;
    readonly revision: ArtifactRevision;
  }
  | {
    readonly type: "failed";
    readonly id: AssetId;
    readonly revision: ArtifactRevision;
    readonly location: string;
    readonly reason: string;
  };

export async function load_artifact(
  entry: AssetManifestEntry,
  reader: ArtifactReader,
  signal: AbortSignal = new AbortController().signal,
): Promise<ArtifactLoadResult> {
  if (signal.aborted) return cancelled(entry);

  let bytes: Uint8Array;
  try {
    bytes = await reader.read(entry.location, signal);
  } catch (error) {
    if (signal.aborted || is_abort_error(error)) return cancelled(entry);
    return failed(
      entry,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (signal.aborted) return cancelled(entry);
  if (bytes.length !== entry.byte_size) {
    return failed(
      entry,
      `artifact byte size ${bytes.length} does not match manifest byte size ${entry.byte_size}`,
    );
  }
  const verified = await verify_digest(bytes, entry.digest);
  if (signal.aborted) return cancelled(entry);
  if (verified.type === "digest_mismatch") {
    return failed(
      entry,
      `artifact digest ${verified.actual} does not match manifest digest ${verified.expected}`,
    );
  }
  return {
    type: "ready",
    id: entry.id,
    revision: entry.artifact_revision,
    bytes: bytes.slice(),
  };
}

function cancelled(
  entry: AssetManifestEntry,
): Extract<ArtifactLoadResult, { type: "cancelled" }> {
  return {
    type: "cancelled",
    id: entry.id,
    revision: entry.artifact_revision,
  };
}

function failed(
  entry: AssetManifestEntry,
  reason: string,
): Extract<ArtifactLoadResult, { type: "failed" }> {
  return {
    type: "failed",
    id: entry.id,
    revision: entry.artifact_revision,
    location: entry.location,
    reason,
  };
}

function is_abort_error(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
