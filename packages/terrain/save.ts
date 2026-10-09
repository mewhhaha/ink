/**
 * Saving edited terrain and scatter data back to their asset files, in place,
 * through the dev server's `assets-write` route (see `packages/dev`).
 *
 * A terrain file is 20 MB or more and a stroke changes a few kilobytes of it,
 * so the saver sends only what changed: the rows of the changed heights, the
 * changed splat texels of every plane, the matching part of the overview and
 * the revision in the header, as the byte ranges of one request. Changes are
 * collected for a moment so a flurry of strokes (or an undo and a redo) is one
 * request, and the revision goes last so a write that fails halfway never
 * claims data it did not finish. A scatter file is small and is replaced
 * whole.
 */
import {
  type Heightfield,
  overviewCellsOf,
  ScatterSet,
  terrainLayout,
  terrainPlanes,
  type TerrainRect,
} from "@ink/geometry";
import type { ScatterResource, TerrainResource } from "@ink/render";

/** The part of `DevClient` the savers use. */
export interface AssetSink {
  patchAsset(
    path: string,
    segments: readonly { offset: number; bytes: Uint8Array }[],
  ): Promise<void>;
  putAsset(path: string, bytes: Uint8Array): Promise<void>;
}

export interface Segment {
  offset: number;
  bytes: Uint8Array;
}

/** Byte offset of the revision in a terrain file's header. */
export const REVISION_OFFSET = 20;

export interface TerrainDirty {
  /** Changed height samples (exclusive ends), or null. */
  rect: TerrainRect | null;
  /** Changed splat texels, or null. */
  splatRect: TerrainRect | null;
}

const clip = (r: TerrainRect, w: number, h: number): TerrainRect | null => {
  const out = {
    x0: Math.max(0, r.x0),
    z0: Math.max(0, r.z0),
    x1: Math.min(w, r.x1),
    z1: Math.min(h, r.z1),
  };
  return out.x1 > out.x0 && out.z1 > out.z0 ? out : null;
};

/** The byte ranges that bring a `*.terrain` file up to date with `field`
 * after the samples and texels in `dirty` changed. Applying them to a file
 * made from the field before the change gives `field.serialize()`. */
export function terrainSegments(
  field: Heightfield,
  dirty: TerrainDirty,
  revision: number,
): Segment[] {
  const overviewCells = overviewCellsOf(field.cells);
  const layout = terrainLayout({
    cells: field.cells,
    splatCells: field.splatCells,
    layers: field.layers,
    revision,
    overviewCells,
  });
  const out: Segment[] = [];
  const bytes = (
    array: Float32Array | Uint8Array,
    from: number,
    to: number,
  ) => {
    const size = array.BYTES_PER_ELEMENT;
    return new Uint8Array(
      array.buffer,
      array.byteOffset + from * size,
      (to - from) * size,
    );
  };
  // Rows of a rectangle of a row-major grid; whole rows join into one range.
  const rows = (
    r: TerrainRect,
    stride: number,
    texel: number,
    base: number,
    array: Float32Array | Uint8Array,
    perTexel: number,
  ) => {
    if (r.x0 === 0 && r.x1 === stride) {
      out.push({
        offset: base + r.z0 * stride * texel,
        bytes: bytes(array, r.z0 * stride * perTexel, r.z1 * stride * perTexel),
      });
      return;
    }
    for (let z = r.z0; z < r.z1; z++) {
      out.push({
        offset: base + (z * stride + r.x0) * texel,
        bytes: bytes(
          array,
          (z * stride + r.x0) * perTexel,
          (z * stride + r.x1) * perTexel,
        ),
      });
    }
  };

  const rect = dirty.rect && clip(dirty.rect, field.stride, field.stride);
  if (rect) {
    rows(rect, field.stride, 4, layout.heights, field.heights, 1);
    // The overview samples every `step`th sample of the field.
    const step = field.cells / overviewCells;
    const n = overviewCells + 1;
    const o = clip(
      {
        x0: Math.floor(rect.x0 / step),
        z0: Math.floor(rect.z0 / step),
        x1: Math.ceil((rect.x1 - 1) / step) + 1,
        z1: Math.ceil((rect.z1 - 1) / step) + 1,
      },
      n,
      n,
    );
    if (o) {
      const block = new Float32Array((o.x1 - o.x0) * (o.z1 - o.z0));
      for (let z = o.z0; z < o.z1; z++) {
        for (let x = o.x0; x < o.x1; x++) {
          block[(z - o.z0) * (o.x1 - o.x0) + (x - o.x0)] = field.sampleCell(
            x * step,
            z * step,
          );
        }
      }
      for (let z = o.z0; z < o.z1; z++) {
        out.push({
          offset: layout.overview + (z * n + o.x0) * 4,
          bytes: bytes(
            block,
            (z - o.z0) * (o.x1 - o.x0),
            (z - o.z0 + 1) * (o.x1 - o.x0),
          ),
        });
      }
    }
  }
  const splat = dirty.splatRect &&
    clip(dirty.splatRect, field.splatCells, field.splatCells);
  if (splat) {
    const n = field.splatCells;
    for (let p = 0; p < terrainPlanes(field.layers); p++) {
      rows(
        splat,
        n,
        4,
        layout.splat + p * n * n * 4,
        field.splat.subarray(p * n * n * 4, (p + 1) * n * n * 4),
        4,
      );
    }
  }
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, revision, true);
  out.push({ offset: REVISION_OFFSET, bytes: header });
  return out;
}

const union = (a: TerrainRect | null, b: TerrainRect | null) =>
  !a ? b : !b ? a : {
    x0: Math.min(a.x0, b.x0),
    z0: Math.min(a.z0, b.z0),
    x1: Math.max(a.x1, b.x1),
    z1: Math.max(a.z1, b.z1),
  };

export interface SaverOptions {
  /** Quiet time before a write, milliseconds. */
  delay?: number;
  /** The longest a change waits while more keep coming. */
  maxWait?: number;
  onError?: (error: unknown) => void;
}

/** Collects changes and writes them, one request at a time. */
abstract class Saver {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #first = 0;
  #writing: Promise<void> = Promise.resolve();
  #disposed = false;
  protected abstract pending: boolean;

  constructor(protected options: SaverOptions) {}

  protected schedule() {
    const now = Date.now();
    if (!this.#first) this.#first = now;
    clearTimeout(this.#timer);
    const wait = Math.min(
      this.options.delay ?? 250,
      Math.max(0, this.#first + (this.options.maxWait ?? 2000) - now),
    );
    this.#timer = setTimeout(() => void this.flush(), wait);
  }

  protected abstract write(): Promise<void>;

  /** Whether changes wait to be written. */
  get dirty(): boolean {
    return this.pending;
  }

  /** Write what is waiting now; resolves when it is on disk (or failed). */
  flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#first = 0;
    this.#writing = this.#writing.then(async () => {
      while (this.pending && !this.#disposed) {
        try {
          await this.write();
        } catch (error) {
          this.options.onError?.(error);
          return;
        }
      }
    });
    return this.#writing;
  }

  /** Write what is waiting, then stop listening. */
  async dispose(): Promise<void> {
    await this.flush();
    this.#disposed = true;
    this.stop();
  }

  protected abstract stop(): void;
}

/** Keeps a terrain asset's file in step with its resource's edits. */
export class TerrainSaver extends Saver {
  protected pending = false;
  #dirty: TerrainDirty = { rect: null, splatRect: null };
  #off: () => void;

  constructor(
    readonly resource: TerrainResource,
    readonly sink: AssetSink,
    options: SaverOptions = {},
  ) {
    super(options);
    this.#off = resource.onChange((change) => {
      if (change.cause === "load") {
        // The file is where the data came from.
        this.pending = false;
        this.#dirty = { rect: null, splatRect: null };
        return;
      }
      this.#dirty = {
        rect: union(this.#dirty.rect, change.patch.rect),
        splatRect: union(this.#dirty.splatRect, change.patch.splatRect),
      };
      this.pending = true;
      this.schedule();
    });
  }

  protected async write() {
    const field = this.resource.field;
    const dirty = this.#dirty;
    this.#dirty = { rect: null, splatRect: null };
    this.pending = false;
    if (!field) return;
    try {
      await this.sink.patchAsset(
        this.resource.path,
        terrainSegments(field, dirty, this.resource.revision),
      );
    } catch (error) {
      // Keep it for the next try.
      this.#dirty = {
        rect: union(this.#dirty.rect, dirty.rect),
        splatRect: union(this.#dirty.splatRect, dirty.splatRect),
      };
      this.pending = true;
      throw error;
    }
  }

  protected stop() {
    this.#off();
  }
}

/** Keeps a scatter asset's file in step with its resource's edits. */
export class ScatterSaver extends Saver {
  protected pending = false;
  #off: () => void;

  constructor(
    readonly resource: ScatterResource,
    readonly sink: AssetSink,
    options: SaverOptions = {},
  ) {
    super(options);
    this.#off = resource.onChange((change) => {
      if (change.cause === "load") {
        this.pending = false;
        return;
      }
      this.pending = true;
      this.schedule();
    });
  }

  protected async write() {
    const set = this.resource.set;
    this.pending = false;
    if (!set) return;
    // The file is sorted by chunk; sort a copy, not the set the renderer reads.
    const copy = ScatterSet.from(
      set.data.slice(0, set.count * 6),
      this.resource.revision,
    );
    try {
      await this.sink.putAsset(this.resource.path, copy.serialize());
    } catch (error) {
      this.pending = true;
      throw error;
    }
  }

  protected stop() {
    this.#off();
  }
}
