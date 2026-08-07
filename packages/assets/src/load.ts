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
  const artifact = { ...entry };
  if (signal.aborted) return cancelled(artifact);

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await reader.read(artifact.location, signal));
  } catch (error) {
    if (signal.aborted || is_abort_error(error)) return cancelled(artifact);
    return failed(
      artifact,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (signal.aborted) return cancelled(artifact);
  if (bytes.length !== artifact.byte_size) {
    return failed(
      artifact,
      `artifact byte size ${bytes.length} does not match manifest byte size ${artifact.byte_size}`,
    );
  }
  let verified: Awaited<ReturnType<typeof verify_digest>>;
  try {
    verified = await verify_digest(bytes, artifact.digest);
  } catch (error) {
    if (signal.aborted || is_abort_error(error)) return cancelled(artifact);
    return failed(
      artifact,
      `artifact digest verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (signal.aborted) return cancelled(artifact);
  if (verified.type === "digest_mismatch") {
    return failed(
      artifact,
      `artifact digest ${verified.actual} does not match manifest digest ${verified.expected}`,
    );
  }
  return {
    type: "ready",
    id: artifact.id,
    revision: artifact.artifact_revision,
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
