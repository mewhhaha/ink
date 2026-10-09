/**
 * CPU side of a terrain asset, shared by the renderer (which uploads what
 * changed), the tools (which edit it) and game-facing queries. GPU-free.
 *
 * Loading streams the `*.terrain` file: the overview section arrives first
 * (`overview`, state `overview`) so the whole terrain can be drawn at once;
 * the full field follows (state `ready`).
 *
 * Edits go through strokes. A stroke records the touched region before and
 * after; committing it bumps `revision` and keeps the pair so the scene's
 * undo history (which stores the revision in the `terrain` component) can
 * move the heightfield with `seek(revision)`.
 */
import {
  clampRect,
  Heightfield,
  heightRange,
  overviewCellsOf,
  readPatch,
  readTerrainHeader,
  type TerrainHeader,
  terrainLayout,
  type TerrainPatch,
  type TerrainRect,
  writePatch,
} from "@ink/geometry";

/** Cells per leaf of the min/max tree and per streamed upload tile. */
export const TERRAIN_LEAF = 32;
export const TERRAIN_TILE = 256;

export type TerrainState = "loading" | "overview" | "ready" | "failed";

export interface TerrainChange {
  /** What changed, in field sample coordinates (heights) and splat texels. */
  patch: TerrainPatch;
  revision: number;
  /** Why: a stroke by a tool, undo/redo (`seek`), or a reload from disk. */
  cause: "stroke" | "seek" | "load";
}

interface Commit {
  before: TerrainPatch;
  after: TerrainPatch;
}

export class TerrainResource {
  state: TerrainState = "loading";
  error?: string;
  header?: TerrainHeader;
  /** Decimated heights, available before the full field. */
  overview?: Float32Array;
  field?: Heightfield;
  /** Bumped on every visible change; the renderer re-reads when it moves. */
  version = 0;
  /** Revision the data currently shows. */
  revision = 0;
  /** Fraction of the file received, 0..1. */
  progress = 0;
  /** Samples that changed since the renderer last uploaded (field space),
   * and the splat texels likewise. */
  dirty: TerrainRect | null = null;
  splatDirty: TerrainRect | null = null;
  private history = new Map<number, Commit>();
  private listeners = new Set<(change: TerrainChange) => void>();
  private readyListeners = new Set<() => void>();
  /** Min/max of every leaf (`TERRAIN_LEAF` cells), 2 floats each. */
  private leaves = new Float32Array(0);
  private leafColumns = 0;
  private leafDirty = new Set<number>();
  private controller?: AbortController;

  constructor(readonly path: string) {}

  /** A resource that is already loaded, e.g. made by a script or a test. */
  static ready(path: string, field: Heightfield): TerrainResource {
    const t = new TerrainResource(path);
    t.setField(field);
    return t;
  }

  onChange(listener: (change: TerrainChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Calls back once the full field is available (immediately if it is). */
  whenReady(listener: () => void): () => void {
    if (this.state === "ready") {
      listener();
      return () => {};
    }
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  // Loading -------------------------------------------------------------------

  async load(url: string, fetcher: typeof fetch = fetch): Promise<void> {
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    try {
      const response = await fetcher(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      const reader = response.body?.getReader();
      if (!reader) {
        this.accept(new Uint8Array(await response.arrayBuffer()));
        return;
      }
      let buffer: Uint8Array | undefined;
      let have = 0;
      let header: TerrainHeader | undefined;
      let layout: ReturnType<typeof terrainLayout> | undefined;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!buffer) {
          // The header tells how large the file is; the first chunk holds it.
          header = readTerrainHeader(value);
          layout = terrainLayout(header);
          buffer = new Uint8Array(layout.end);
          this.header = header;
        }
        buffer.set(value.subarray(0, Math.max(0, buffer.length - have)), have);
        have += value.length;
        this.progress = Math.min(1, have / buffer.length);
        if (this.state === "loading" && have >= layout!.heights) {
          this.overview = new Float32Array(
            buffer.slice(layout!.overview, layout!.heights).buffer,
          );
          this.state = "overview";
          this.version++;
          this.notifyChange();
        }
      }
      if (!buffer || have < layout!.end) throw new Error("terrain truncated");
      this.accept(buffer);
    } catch (error) {
      if (controller.signal.aborted) return;
      this.state = "failed";
      this.error = error instanceof Error ? error.message : String(error);
      this.version++;
      this.notifyChange();
    }
  }

  private notifyChange() {
    for (const l of this.changeListeners) l();
  }
  private changeListeners = new Set<() => void>();
  /** Coarse notification for state/progress changes (not edits). */
  onState(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private accept(bytes: Uint8Array) {
    this.setField(Heightfield.parse(bytes));
  }

  /** Replace the data (initial load, or a reload after an outside change). */
  setField(field: Heightfield) {
    const reload = !!this.field;
    this.field = field;
    this.header = {
      cells: field.cells,
      splatCells: field.splatCells,
      layers: field.layers,
      revision: field.revision,
      overviewCells: overviewCellsOf(field.cells),
    };
    this.revision = field.revision;
    this.history.clear();
    this.state = "ready";
    this.progress = 1;
    this.rebuildLeaves();
    this.dirty = { x0: 0, z0: 0, x1: field.stride, z1: field.stride };
    this.splatDirty = {
      x0: 0,
      z0: 0,
      x1: field.splatCells,
      z1: field.splatCells,
    };
    this.version++;
    if (reload) {
      this.emit({
        patch: readPatch(field, this.dirty),
        revision: this.revision,
        cause: "load",
      });
    }
    this.notifyChange();
    for (const l of this.readyListeners) l();
    this.readyListeners.clear();
  }

  // Editing -------------------------------------------------------------------

  /** Begin a stroke over a region. Capture `before` now; call `finish` once
   * the field has been modified in place. */
  stroke(area: TerrainRect): TerrainStroke {
    const field = this.field;
    if (!field) throw new Error("terrain is not loaded");
    const rect = clampRect(field, area);
    return new TerrainStroke(this, field, rect, readPatch(field, rect));
  }

  /** Called by `TerrainStroke.touch`/`finish`: the region changed. */
  markDirty(rect: TerrainRect, splat?: TerrainRect) {
    const field = this.field!;
    const r = clampRect(field, rect);
    this.dirty = union(this.dirty, r);
    if (splat) this.splatDirty = union(this.splatDirty, splat);
    const lx0 = Math.floor(Math.max(0, r.x0 - 1) / TERRAIN_LEAF),
      lx1 = Math.floor(Math.min(field.cells, r.x1) / TERRAIN_LEAF);
    const lz0 = Math.floor(Math.max(0, r.z0 - 1) / TERRAIN_LEAF),
      lz1 = Math.floor(Math.min(field.cells, r.z1) / TERRAIN_LEAF);
    for (let z = lz0; z <= lz1; z++) {
      for (let x = lx0; x <= lx1; x++) {
        if (x < this.leafColumns && z < this.leafColumns) {
          this.leafDirty.add(z * this.leafColumns + x);
        }
      }
    }
    this.version++;
  }

  commit(before: TerrainPatch, after: TerrainPatch): number {
    // A new edit forks history: redo entries above the current revision go.
    for (const key of [...this.history.keys()]) {
      if (key > this.revision) this.history.delete(key);
    }
    this.revision++;
    this.history.set(this.revision, { before, after });
    this.field!.revision = this.revision;
    this.emit({ patch: after, revision: this.revision, cause: "stroke" });
    return this.revision;
  }

  /** Move the data to a revision the scene refers to (undo/redo). Returns
   * whether it got there; history is only kept for this session. */
  seek(target: number): boolean {
    const field = this.field;
    if (!field) return false;
    while (this.revision > target) {
      const commit = this.history.get(this.revision);
      if (!commit) return false;
      this.apply(commit.before);
      this.revision--;
      field.revision = this.revision;
      this.emit({
        patch: commit.before,
        revision: this.revision,
        cause: "seek",
      });
    }
    while (this.revision < target) {
      const commit = this.history.get(this.revision + 1);
      if (!commit) return false;
      this.apply(commit.after);
      this.revision++;
      field.revision = this.revision;
      this.emit({
        patch: commit.after,
        revision: this.revision,
        cause: "seek",
      });
    }
    return true;
  }

  private apply(patch: TerrainPatch) {
    writePatch(this.field!, patch);
    this.markDirty(patch.rect, patch.splatRect);
  }

  private emit(change: TerrainChange) {
    for (const l of this.listeners) l(change);
  }

  // Queries -------------------------------------------------------------------

  /** Take the regions changed since the last call (the renderer's upload). */
  takeDirty(): { heights: TerrainRect | null; splat: TerrainRect | null } {
    const out = { heights: this.dirty, splat: this.splatDirty };
    this.dirty = null;
    this.splatDirty = null;
    return out;
  }

  private rebuildLeaves() {
    const field = this.field!;
    this.leafColumns = Math.ceil(field.cells / TERRAIN_LEAF);
    this.leaves = new Float32Array(this.leafColumns ** 2 * 2);
    for (let i = 0; i < this.leafColumns ** 2; i++) this.computeLeaf(i);
    this.leafDirty.clear();
  }

  private computeLeaf(index: number) {
    const field = this.field!;
    const x = index % this.leafColumns,
      z = Math.floor(index / this.leafColumns);
    const [lo, hi] = heightRange(field, {
      x0: x * TERRAIN_LEAF,
      z0: z * TERRAIN_LEAF,
      x1: (x + 1) * TERRAIN_LEAF + 1,
      z1: (z + 1) * TERRAIN_LEAF + 1,
    });
    this.leaves[index * 2] = lo;
    this.leaves[index * 2 + 1] = hi;
  }

  /** Min/max height (field units) over leaf columns/rows [x0,x1) × [z0,z1).
   * Before the field is ready the overview's global range is used. */
  boundsOf(x0: number, z0: number, x1: number, z1: number): [number, number] {
    if (!this.field) {
      const o = this.overview;
      if (!o) return [0, 0];
      let lo = Infinity, hi = -Infinity;
      for (const v of o) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return [lo, hi];
    }
    for (const index of this.leafDirty) this.computeLeaf(index);
    this.leafDirty.clear();
    let lo = Infinity, hi = -Infinity;
    const c = this.leafColumns;
    for (let z = Math.max(0, z0); z < Math.min(c, z1); z++) {
      for (let x = Math.max(0, x0); x < Math.min(c, x1); x++) {
        lo = Math.min(lo, this.leaves[(z * c + x) * 2]);
        hi = Math.max(hi, this.leaves[(z * c + x) * 2 + 1]);
      }
    }
    return lo > hi ? [0, 0] : [lo, hi];
  }

  get leafCount(): number {
    return this.leafColumns;
  }

  dispose() {
    this.controller?.abort();
    this.listeners.clear();
    this.changeListeners.clear();
    this.readyListeners.clear();
  }
}

/** An edit in progress. Modify `resource.field` in place, call `touch` with
 * the area you changed, then `finish`. */
export class TerrainStroke {
  private area: TerrainRect;
  constructor(
    private resource: TerrainResource,
    private field: Heightfield,
    rect: TerrainRect,
    private before: TerrainPatch,
  ) {
    this.area = rect;
  }

  /** The region this stroke may touch. */
  get rect(): TerrainRect {
    return this.area;
  }

  /** Mark the region just modified so the renderer uploads it. */
  touch(area: TerrainRect, splat?: TerrainRect) {
    this.resource.markDirty(area, splat);
  }

  /** End the stroke: returns the new revision, or null if nothing changed. */
  finish():
    | { revision: number; before: TerrainPatch; after: TerrainPatch }
    | null {
    const after = readPatch(this.field, this.area);
    if (
      same(after.heights, this.before.heights) &&
      same(after.splat, this.before.splat)
    ) return null;
    const revision = this.resource.commit(this.before, after);
    return { revision, before: this.before, after };
  }
}

function same(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function union(a: TerrainRect | null, b: TerrainRect): TerrainRect {
  return a
    ? {
      x0: Math.min(a.x0, b.x0),
      z0: Math.min(a.z0, b.z0),
      x1: Math.max(a.x1, b.x1),
      z1: Math.max(a.z1, b.z1),
    }
    : { ...b };
}
