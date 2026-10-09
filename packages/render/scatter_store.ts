/**
 * CPU side of a scatter asset: the placements of one instance layer, shared
 * by the renderer and the painting tools. A stroke adds and removes
 * placements; committing it bumps `revision` and keeps the difference so the
 * scene's undo history (the `scatter` component stores the revision) can move
 * the set with `seek`, as for terrain.
 */
import { type Placement, ScatterSet } from "@ink/geometry";

export type ScatterState = "loading" | "ready" | "failed";

export interface ScatterChange {
  added: Placement[];
  removed: Placement[];
  revision: number;
  cause: "stroke" | "seek" | "load";
}

interface Commit {
  added: Placement[];
  removed: Placement[];
}

export class ScatterResource {
  state: ScatterState = "loading";
  error?: string;
  set?: ScatterSet;
  /** Bumped on every change; the renderer re-reads when it moves. */
  version = 0;
  revision = 0;
  private history = new Map<number, Commit>();
  private listeners = new Set<(change: ScatterChange) => void>();
  private stateListeners = new Set<() => void>();
  private controller?: AbortController;

  constructor(readonly path: string) {}

  static ready(path: string, set: ScatterSet): ScatterResource {
    const r = new ScatterResource(path);
    r.setSet(set);
    return r;
  }

  onChange(listener: (change: ScatterChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onState(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  async load(url: string, fetcher: typeof fetch = fetch): Promise<void> {
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    try {
      const response = await fetcher(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      this.setSet(ScatterSet.parse(await response.arrayBuffer()));
    } catch (error) {
      if (controller.signal.aborted) return;
      this.state = "failed";
      this.error = error instanceof Error ? error.message : String(error);
      this.version++;
      for (const l of this.stateListeners) l();
    }
  }

  setSet(set: ScatterSet) {
    const reload = !!this.set;
    this.set = set;
    this.revision = set.revision;
    this.history.clear();
    this.state = "ready";
    this.version++;
    if (reload) {
      this.emit({
        added: [],
        removed: [],
        revision: this.revision,
        cause: "load",
      });
    }
    for (const l of this.stateListeners) l();
  }

  /** Apply a stroke's result: `removed` placements are taken out (matched by
   * value), `added` ones appended. Returns the new revision. */
  edit(added: Placement[], removed: Placement[]): number {
    const set = this.set;
    if (!set) throw new Error("scatter is not loaded");
    for (const key of [...this.history.keys()]) {
      if (key > this.revision) this.history.delete(key);
    }
    this.removeValues(removed);
    for (const p of added) set.add(p);
    this.revision++;
    set.revision = this.revision;
    this.history.set(this.revision, { added, removed });
    this.version++;
    this.emit({ added, removed, revision: this.revision, cause: "stroke" });
    return this.revision;
  }

  /** Change the set now without a revision: one step of a drag that the
   * tool will `record` as a single revision when it ends. The renderer sees
   * each step at once. */
  apply(added: Placement[], removed: Placement[]): void {
    const set = this.set;
    if (!set) throw new Error("scatter is not loaded");
    this.removeValues(removed);
    for (const p of added) set.add(p);
    this.version++;
    this.emit({ added, removed, revision: this.revision, cause: "stroke" });
  }

  /** Make everything `apply` changed since the last `record` one revision:
   * `added` and `removed` are the net result of the whole drag. Returns the
   * new revision. */
  record(added: Placement[], removed: Placement[]): number {
    const set = this.set;
    if (!set) throw new Error("scatter is not loaded");
    for (const key of [...this.history.keys()]) {
      if (key > this.revision) this.history.delete(key);
    }
    this.revision++;
    set.revision = this.revision;
    this.history.set(this.revision, { added, removed });
    this.version++;
    // Nothing more to draw, but whoever saves the set learns the revision.
    this.emit({
      added: [],
      removed: [],
      revision: this.revision,
      cause: "stroke",
    });
    return this.revision;
  }

  seek(target: number): boolean {
    const set = this.set;
    if (!set) return false;
    while (this.revision > target) {
      const commit = this.history.get(this.revision);
      if (!commit) return false;
      this.removeValues(commit.added);
      for (const p of commit.removed) set.add(p);
      this.revision--;
      set.revision = this.revision;
      this.version++;
      this.emit({
        added: commit.removed,
        removed: commit.added,
        revision: this.revision,
        cause: "seek",
      });
    }
    while (this.revision < target) {
      const commit = this.history.get(this.revision + 1);
      if (!commit) return false;
      this.removeValues(commit.removed);
      for (const p of commit.added) set.add(p);
      this.revision++;
      set.revision = this.revision;
      this.version++;
      this.emit({
        added: commit.added,
        removed: commit.removed,
        revision: this.revision,
        cause: "seek",
      });
    }
    return true;
  }

  private removeValues(list: Placement[]) {
    if (!list.length) return;
    const keys = new Set(list.map(keyOf));
    // Most records differ in x already; only those that match build a key.
    const xs = new Set(list.map((p) => Math.fround(p.x)));
    this.set!.filter((p) => !(xs.has(p.x) && keys.delete(keyOf(p))));
  }

  private emit(change: ScatterChange) {
    for (const l of this.listeners) l(change);
  }

  dispose() {
    this.controller?.abort();
    this.listeners.clear();
    this.stateListeners.clear();
  }
}

const keyOf = (p: Placement) =>
  `${Math.fround(p.x)},${Math.fround(p.y)},${Math.fround(p.z)},${
    Math.fround(p.yaw)
  },${Math.fround(p.scale)},${Math.fround(p.tint)}`;
