/**
 * Keeps terrain and scatter data in step with the scene.
 *
 * A stroke edits the data and, in the same session edit, records the new
 * `revision` in the entity's component. Undo, redo, rewinding the timeline
 * and loading a scene change the component's revision without touching the
 * data; `WorldSync` notices and moves the data (`resource.seek`) to match. It
 * also saves every change to the data back to its asset file.
 */
import type { Catalog, EntityModel } from "@ink/schema";
import type { ScatterResource, TerrainResource } from "@ink/render";
import {
  type AssetSink,
  type SaverOptions,
  ScatterSaver,
  TerrainSaver,
} from "./save.ts";
import { worldRefs } from "./world.ts";

/** What the sync reads of a `Session`. */
export interface SyncSession {
  readonly world: { entities: readonly EntityModel[] };
  readonly catalog: Catalog;
  readonly mode: string;
  readonly paused: boolean;
  subscribe(listener: () => void): () => void;
}

/** What the sync needs of the renderer's asset store. */
export interface SyncAssets {
  terrain(path: string): TerrainResource;
  scatter(path: string): ScatterResource;
}

export interface WorldSyncOptions {
  /** Where edits are saved; omit to keep them in memory only. */
  sink?: AssetSink;
  save?: SaverOptions;
  /** While the game runs, look at most this often (ms). */
  playInterval?: number;
}

type Saver = TerrainSaver | ScatterSaver;
const savers = new WeakMap<object, { saver: Saver; users: number }>();

function acquire(resource: object, make: () => Saver): () => void {
  let entry = savers.get(resource);
  if (!entry) {
    entry = { saver: make(), users: 0 };
    savers.set(resource, entry);
  }
  entry.users++;
  const held = entry;
  return () => {
    if (--held.users > 0) return;
    savers.delete(resource);
    void held.saver.dispose();
  };
}

export class WorldSync {
  #releases = new Map<object, () => void>();
  /** `world revision | data revision` of a seek that found no history. */
  #unreachable = new WeakMap<object, string>();
  #waiting = new WeakSet<object>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(
    readonly session: SyncSession,
    readonly assets: SyncAssets,
    readonly options: WorldSyncOptions = {},
  ) {}

  /** Move every resource to the revision the scene records for it. */
  sync(): void {
    const refs = worldRefs(this.session.world, this.session.catalog);
    for (const ref of refs.terrains) {
      const resource = this.assets.terrain(ref.path);
      this.#watch(
        resource,
        () => new TerrainSaver(resource, this.options.sink!, this.options.save),
      );
      this.#follow(resource, ref.revision);
    }
    for (const ref of refs.scatters) {
      const resource = this.assets.scatter(ref.path);
      this.#watch(
        resource,
        () => new ScatterSaver(resource, this.options.sink!, this.options.save),
      );
      this.#follow(resource, ref.revision);
    }
  }

  #watch(resource: TerrainResource | ScatterResource, make: () => Saver) {
    if (this.options.sink && !this.#releases.has(resource)) {
      this.#releases.set(resource, acquire(resource, make));
    }
  }

  #follow(resource: TerrainResource | ScatterResource, revision: number) {
    if (resource.state !== "ready") {
      // Look again once the data has arrived (or failed to).
      if (resource.state !== "failed" && !this.#waiting.has(resource)) {
        this.#waiting.add(resource);
        const off = resource.onState(() => {
          if (resource.state === "loading" || resource.state === "overview") {
            return;
          }
          off();
          this.#waiting.delete(resource);
          if (!this.#stopped) this.sync();
        });
      }
      return;
    }
    if (resource.revision === revision) {
      this.#unreachable.delete(resource);
      return;
    }
    const key = `${revision}|${resource.revision}`;
    if (this.#unreachable.get(resource) === key) return;
    if (resource.seek(revision)) this.#unreachable.delete(resource);
    else this.#unreachable.set(resource, key);
  }

  /** Write whatever is waiting to disk. */
  async flush(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const resource of this.#releases.keys()) {
      const entry = savers.get(resource);
      if (entry) pending.push(entry.saver.flush());
    }
    await Promise.all(pending);
  }

  /** Follow the session until the returned function is called. */
  start(): () => void {
    this.#stopped = false;
    const run = () => {
      const playing = this.session.mode === "play" && !this.session.paused;
      if (!playing) {
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.sync();
      } else if (this.#timer === undefined) {
        // A running game changes the world every step; look now and then.
        this.#timer = setTimeout(() => {
          this.#timer = undefined;
          if (!this.#stopped) this.sync();
        }, this.options.playInterval ?? 250);
      }
    };
    const off = this.session.subscribe(run);
    const hide = () => {
      if (
        typeof document === "undefined" || document.visibilityState === "hidden"
      ) void this.flush();
    };
    globalThis.addEventListener?.("pagehide", hide);
    globalThis.addEventListener?.("visibilitychange", hide);
    this.sync();
    return () => {
      this.#stopped = true;
      off();
      clearTimeout(this.#timer);
      globalThis.removeEventListener?.("pagehide", hide);
      globalThis.removeEventListener?.("visibilitychange", hide);
      void this.flush().finally(() => {
        for (const release of this.#releases.values()) release();
        this.#releases.clear();
      });
    };
  }
}
