import type { Observer } from "@ink/observability/observer.ts";
import type { ArtifactRevision, AssetId } from "./identity.ts";
import type { ArtifactLoadResult } from "./load.ts";

export interface AssetLease {
  readonly id: AssetId;
  readonly revision: ArtifactRevision;
  read(): Uint8Array;
  release(): void;
}

export type AssetCacheState =
  | { readonly type: "unavailable"; readonly id: AssetId }
  | {
    readonly type: "ready";
    readonly id: AssetId;
    readonly revision: ArtifactRevision;
    readonly byte_size: number;
    readonly lease_count: number;
  }
  | {
    readonly type: "evicted";
    readonly id: AssetId;
    readonly revision: ArtifactRevision;
  }
  | {
    readonly type: "failed";
    readonly id: AssetId;
    readonly revision: ArtifactRevision;
    readonly reason: string;
  };

export type CachePublishResult =
  | {
    readonly type: "published";
    readonly id: AssetId;
    readonly evicted: readonly AssetId[];
  }
  | {
    readonly type: "rejected";
    readonly id: AssetId;
    readonly reason: string;
  };

export interface AssetReplacement {
  readonly artifact: Extract<ArtifactLoadResult, { type: "ready" }>;
  readonly dependencies: readonly AssetId[];
}

export type CacheReplacementResult =
  | {
    readonly type: "replaced";
    readonly ids: readonly AssetId[];
    readonly evicted: readonly AssetId[];
  }
  | { readonly type: "rejected"; readonly reason: string };

interface ReadyRecord {
  readonly id: AssetId;
  readonly revision: ArtifactRevision;
  readonly bytes: Uint8Array;
  leases: number;
  last_used: number;
}

export class AssetCache {
  readonly #maximum_bytes: number;
  readonly #observer: Observer | undefined;
  readonly #ready = new Map<AssetId, ReadyRecord>();
  readonly #retired = new Set<ReadyRecord>();
  readonly #states = new Map<AssetId, AssetCacheState>();
  #resident_bytes = 0;
  #use_sequence = 0;

  constructor(maximum_bytes: number, observer?: Observer) {
    if (!Number.isSafeInteger(maximum_bytes) || maximum_bytes < 0) {
      throw new Error(
        `asset cache maximum bytes ${
          JSON.stringify(maximum_bytes)
        } must be a nonnegative safe integer`,
      );
    }
    this.#maximum_bytes = maximum_bytes;
    this.#observer = observer;
  }

  get resident_bytes(): number {
    return this.#resident_bytes;
  }

  get maximum_bytes(): number {
    return this.#maximum_bytes;
  }

  state(id: AssetId): AssetCacheState {
    const ready = this.#ready.get(id);
    if (ready !== undefined) {
      return {
        type: "ready",
        id,
        revision: ready.revision,
        byte_size: ready.bytes.length,
        lease_count: ready.leases,
      };
    }
    return this.#states.get(id) ?? { type: "unavailable", id };
  }

  publish(
    result: Extract<ArtifactLoadResult, { type: "ready" }>,
  ): CachePublishResult {
    if (this.#ready.has(result.id)) {
      return {
        type: "rejected",
        id: result.id,
        reason: `asset ${
          JSON.stringify(result.id)
        } is already resident; replacement requires the hot-replacement API`,
      };
    }
    if (result.bytes.length > this.#maximum_bytes) {
      return {
        type: "rejected",
        id: result.id,
        reason: `asset ${
          JSON.stringify(result.id)
        } has ${result.bytes.length} bytes, exceeding cache budget ${this.#maximum_bytes}`,
      };
    }

    const evicted = this.#evict_for(result.bytes.length);
    if (this.#resident_bytes + result.bytes.length > this.#maximum_bytes) {
      return {
        type: "rejected",
        id: result.id,
        reason: `asset ${
          JSON.stringify(result.id)
        } needs ${result.bytes.length} bytes but ${this.#resident_bytes} of ${this.#maximum_bytes} bytes are pinned by leases`,
      };
    }

    const bytes = result.bytes.slice();
    this.#ready.set(result.id, {
      id: result.id,
      revision: result.revision,
      bytes,
      leases: 0,
      last_used: this.#next_use(),
    });
    this.#states.delete(result.id);
    this.#resident_bytes += bytes.length;
    this.#observer?.event("asset.cache.published", {
      asset_id: result.id,
      revision: result.revision,
      byte_size: bytes.length,
      resident_bytes: this.#resident_bytes,
    });
    return { type: "published", id: result.id, evicted };
  }

  record_failure(
    result: Exclude<ArtifactLoadResult, { type: "ready" | "cancelled" }>,
  ): void {
    if (!this.#ready.has(result.id)) {
      this.#states.set(result.id, {
        type: "failed",
        id: result.id,
        revision: result.revision,
        reason: result.reason,
      });
    }
    this.#observer?.event("asset.load.failed", {
      asset_id: result.id,
      revision: result.revision,
      reason: result.reason,
    });
  }

  replace(replacements: readonly AssetReplacement[]): CacheReplacementResult {
    const ordered = [...replacements].sort((left, right) =>
      left.artifact.id.localeCompare(right.artifact.id)
    );
    const replacement_ids = new Set<AssetId>();
    for (const replacement of ordered) {
      if (replacement_ids.has(replacement.artifact.id)) {
        return {
          type: "rejected",
          reason: `replacement batch repeats asset ${
            JSON.stringify(replacement.artifact.id)
          }`,
        };
      }
      replacement_ids.add(replacement.artifact.id);
    }
    for (const replacement of ordered) {
      for (const dependency of replacement.dependencies) {
        if (!replacement_ids.has(dependency) && !this.#ready.has(dependency)) {
          return {
            type: "rejected",
            reason: `replacement asset ${
              JSON.stringify(replacement.artifact.id)
            } depends on unavailable asset ${JSON.stringify(dependency)}`,
          };
        }
      }
    }

    let projected_bytes = this.#resident_bytes;
    for (const replacement of ordered) {
      const current = this.#ready.get(replacement.artifact.id);
      if (current !== undefined && current.leases === 0) {
        projected_bytes -= current.bytes.length;
      }
      projected_bytes += replacement.artifact.bytes.length;
    }
    const eviction_candidates = Array.from(this.#ready.values())
      .filter((record) =>
        record.leases === 0 && !replacement_ids.has(record.id)
      )
      .sort((left, right) =>
        left.last_used - right.last_used || left.id.localeCompare(right.id)
      );
    const planned_evictions: ReadyRecord[] = [];
    for (const candidate of eviction_candidates) {
      if (projected_bytes <= this.#maximum_bytes) break;
      projected_bytes -= candidate.bytes.length;
      planned_evictions.push(candidate);
    }
    if (projected_bytes > this.#maximum_bytes) {
      return {
        type: "rejected",
        reason:
          `replacement batch needs ${projected_bytes} resident bytes after eviction but cache budget is ${this.#maximum_bytes}`,
      };
    }

    const evicted = planned_evictions.map((record) => {
      this.#evict(record);
      return record.id;
    });
    for (const replacement of ordered) {
      const current = this.#ready.get(replacement.artifact.id);
      if (current !== undefined) {
        this.#ready.delete(current.id);
        if (current.leases === 0) {
          this.#resident_bytes -= current.bytes.length;
        } else {
          this.#retired.add(current);
        }
      }
      const bytes = replacement.artifact.bytes.slice();
      this.#ready.set(replacement.artifact.id, {
        id: replacement.artifact.id,
        revision: replacement.artifact.revision,
        bytes,
        leases: 0,
        last_used: this.#next_use(),
      });
      this.#states.delete(replacement.artifact.id);
      this.#resident_bytes += bytes.length;
      this.#observer?.event("asset.cache.replaced", {
        asset_id: replacement.artifact.id,
        revision: replacement.artifact.revision,
        byte_size: bytes.length,
        resident_bytes: this.#resident_bytes,
      });
    }
    return {
      type: "replaced",
      ids: ordered.map((replacement) => replacement.artifact.id),
      evicted,
    };
  }

  acquire(id: AssetId): AssetLease | undefined {
    const record = this.#ready.get(id);
    if (record === undefined) return undefined;
    record.leases += 1;
    record.last_used = this.#next_use();
    let released = false;
    return {
      id,
      revision: record.revision,
      read: () => {
        if (released) {
          throw new Error(
            `asset lease ${JSON.stringify(id)} was read after release`,
          );
        }
        return record.bytes.slice();
      },
      release: () => {
        if (released) {
          throw new Error(
            `asset lease ${JSON.stringify(id)} was released more than once`,
          );
        }
        released = true;
        record.leases -= 1;
        record.last_used = this.#next_use();
        if (record.leases === 0 && this.#retired.delete(record)) {
          this.#resident_bytes -= record.bytes.length;
        }
      },
    };
  }

  trim(): readonly AssetId[] {
    return this.#evict_for(0, true);
  }

  #evict_for(incoming_bytes: number, evict_all = false): readonly AssetId[] {
    const evicted: AssetId[] = [];
    const candidates = Array.from(this.#ready.values())
      .filter((record) => record.leases === 0)
      .sort((left, right) =>
        left.last_used - right.last_used || left.id.localeCompare(right.id)
      );
    for (const record of candidates) {
      if (
        !evict_all &&
        this.#resident_bytes + incoming_bytes <= this.#maximum_bytes
      ) break;
      this.#evict(record);
      evicted.push(record.id);
    }
    return evicted;
  }

  #evict(record: ReadyRecord): void {
    this.#ready.delete(record.id);
    this.#resident_bytes -= record.bytes.length;
    this.#states.set(record.id, {
      type: "evicted",
      id: record.id,
      revision: record.revision,
    });
    this.#observer?.event("asset.cache.evicted", {
      asset_id: record.id,
      revision: record.revision,
      byte_size: record.bytes.length,
      resident_bytes: this.#resident_bytes,
    });
  }

  #next_use(): number {
    const sequence = this.#use_sequence;
    this.#use_sequence += 1;
    return sequence;
  }
}
