import type { Observer } from "@ink/observability/observer.ts";
import type { AssetPriority } from "./identity.ts";
import {
  type ArtifactLoadResult,
  type ArtifactReader,
  load_artifact,
} from "./load.ts";
import type { AssetManifestEntry } from "./manifest.ts";

interface Subscriber {
  settled: boolean;
  readonly resolve: (result: ArtifactLoadResult) => void;
  readonly remove_abort_listener: () => void;
}

interface LoadTask {
  readonly key: string;
  readonly entry: AssetManifestEntry;
  readonly cancellation: AbortController;
  readonly subscribers: Set<Subscriber>;
  priority: AssetPriority;
  readonly sequence: number;
  active: boolean;
}

const priority_rank: Readonly<Record<AssetPriority, number>> = {
  blocking: 0,
  visible: 1,
  background: 2,
};

export class AssetLoadQueue {
  readonly #reader: ArtifactReader;
  readonly #maximum_concurrent: number;
  readonly #observer: Observer | undefined;
  readonly #tasks = new Map<string, LoadTask>();
  #active = 0;
  #sequence = 0;

  constructor(
    reader: ArtifactReader,
    maximum_concurrent: number,
    observer?: Observer,
  ) {
    if (!Number.isSafeInteger(maximum_concurrent) || maximum_concurrent <= 0) {
      throw new Error(
        `asset load concurrency ${
          JSON.stringify(maximum_concurrent)
        } must be a positive safe integer`,
      );
    }
    this.#reader = reader;
    this.#maximum_concurrent = maximum_concurrent;
    this.#observer = observer;
  }

  request(
    entry: AssetManifestEntry,
    priority: AssetPriority,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ArtifactLoadResult> {
    if (signal.aborted) return Promise.resolve(cancelled(entry));
    const key = `${entry.id}\u0000${entry.artifact_revision}`;
    let task = this.#tasks.get(key);
    if (task === undefined) {
      task = {
        key,
        entry,
        cancellation: new AbortController(),
        subscribers: new Set(),
        priority,
        sequence: this.#sequence,
        active: false,
      };
      this.#sequence += 1;
      this.#tasks.set(key, task);
    } else if (priority_rank[priority] < priority_rank[task.priority]) {
      task.priority = priority;
    }

    const promise = new Promise<ArtifactLoadResult>((resolve) => {
      const abort = () => {
        if (subscriber.settled) return;
        subscriber.settled = true;
        task!.subscribers.delete(subscriber);
        subscriber.remove_abort_listener();
        resolve(cancelled(entry));
        if (task!.subscribers.size === 0) {
          task!.cancellation.abort();
          if (!task!.active) this.#tasks.delete(task!.key);
        }
      };
      const subscriber: Subscriber = {
        settled: false,
        resolve,
        remove_abort_listener: () => signal.removeEventListener("abort", abort),
      };
      task!.subscribers.add(subscriber);
      signal.addEventListener("abort", abort, { once: true });
    });
    this.#start_available();
    return promise;
  }

  #start_available(): void {
    while (this.#active < this.#maximum_concurrent) {
      const task = Array.from(this.#tasks.values())
        .filter((candidate) =>
          !candidate.active && candidate.subscribers.size > 0
        )
        .sort((left, right) =>
          priority_rank[left.priority] - priority_rank[right.priority] ||
          left.sequence - right.sequence
        )[0];
      if (task === undefined) return;
      task.active = true;
      this.#active += 1;
      this.#observer?.event("asset.load.started", {
        asset_id: task.entry.id,
        revision: task.entry.artifact_revision,
        priority: task.priority,
      });
      load_artifact(task.entry, this.#reader, task.cancellation.signal)
        .then((result) => this.#complete(task, result))
        .catch((error) => {
          this.#complete(task, {
            type: "failed",
            id: task.entry.id,
            revision: task.entry.artifact_revision,
            location: task.entry.location,
            reason: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }

  #complete(task: LoadTask, result: ArtifactLoadResult): void {
    if (!task.active) {
      throw new Error(
        `asset load task ${JSON.stringify(task.key)} completed while inactive`,
      );
    }
    task.active = false;
    this.#active -= 1;
    this.#tasks.delete(task.key);
    for (const subscriber of task.subscribers) {
      if (subscriber.settled) continue;
      subscriber.settled = true;
      subscriber.remove_abort_listener();
      subscriber.resolve(result);
    }
    task.subscribers.clear();
    this.#observer?.event(`asset.load.${result.type}`, {
      asset_id: task.entry.id,
      revision: task.entry.artifact_revision,
    });
    this.#start_available();
  }
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
