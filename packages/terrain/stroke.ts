/**
 * Records a drag over a terrain so it can be undone, without knowing in
 * advance how far the drag will go.
 *
 * `TerrainResource.stroke(rect)` copies a fixed rectangle up front; a
 * brush stroke across a kilometre would have to copy the whole field (and
 * keep two copies in history). The recorder instead saves each `TILE`-sample
 * tile the first time a dab is about to change it. When the stroke ends,
 * every tile that changed becomes one small history entry of the resource
 * (`commit(before, after)`), so a drag is a handful of revisions that the
 * scene's single edit refers to by the last one: `seek` unwinds them all.
 *
 *   const stroke = new StrokeRecorder(resource);
 *   // for every dab, before the operation changes anything:
 *   stroke.prepare(footprint(ground, dab));
 *   const touched = raise(ground, dab, 1);
 *   resource.markDirty(touched.rect!);
 *   // when the drag ends:
 *   const done = stroke.finish(); // { revision, area }, or null
 */
import {
  type Heightfield,
  readPatch,
  type TerrainPatch,
  terrainPlanes,
  type TerrainRect,
} from "@ink/geometry";
import type { TerrainResource } from "@ink/render";
import type { Footprint } from "./sculpt.ts";

/** Samples (and splat texels) per saved tile. */
export const STROKE_TILE = 64;

interface Saved<T> {
  rect: TerrainRect;
  data: T;
}

const rectsMeet = (a: TerrainRect, b: TerrainRect) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;

const union = (a: TerrainRect | null, b: TerrainRect): TerrainRect =>
  a
    ? {
      x0: Math.min(a.x0, b.x0),
      z0: Math.min(a.z0, b.z0),
      x1: Math.max(a.x1, b.x1),
      z1: Math.max(a.z1, b.z1),
    }
    : { ...b };

const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

export class StrokeRecorder {
  readonly field: Heightfield;
  #heights = new Map<number, Saved<Float32Array>>();
  #splats = new Map<number, Saved<Uint8Array>>();
  #area: TerrainRect | null = null;
  #done = false;

  constructor(readonly resource: TerrainResource) {
    if (!resource.field) throw new Error("terrain is not loaded");
    this.field = resource.field;
  }

  /** Whether any dab has been prepared. */
  get started(): boolean {
    return this.#heights.size > 0 || this.#splats.size > 0;
  }

  /** Save what `footprint` is about to change. Call before the operation. */
  prepare(footprint: Footprint): void {
    const { field } = this;
    const { rect, splatRect } = footprint;
    if (rect) {
      this.#area = union(this.#area, rect);
      const columns = Math.ceil(field.stride / STROKE_TILE);
      for (
        let tz = Math.floor(rect.z0 / STROKE_TILE);
        tz * STROKE_TILE < rect.z1;
        tz++
      ) {
        for (
          let tx = Math.floor(rect.x0 / STROKE_TILE);
          tx * STROKE_TILE < rect.x1;
          tx++
        ) {
          const key = tz * columns + tx;
          if (this.#heights.has(key)) continue;
          const tile = this.#tile(tx, tz, field.stride);
          const w = tile.x1 - tile.x0, h = tile.z1 - tile.z0;
          const data = new Float32Array(w * h);
          for (let z = 0; z < h; z++) {
            const from = (tile.z0 + z) * field.stride + tile.x0;
            data.set(field.heights.subarray(from, from + w), z * w);
          }
          this.#heights.set(key, { rect: tile, data });
        }
      }
    }
    if (splatRect) {
      const n = field.splatCells;
      const columns = Math.ceil(n / STROKE_TILE);
      for (
        let tz = Math.floor(splatRect.z0 / STROKE_TILE);
        tz * STROKE_TILE < splatRect.z1;
        tz++
      ) {
        for (
          let tx = Math.floor(splatRect.x0 / STROKE_TILE);
          tx * STROKE_TILE < splatRect.x1;
          tx++
        ) {
          const key = tz * columns + tx;
          if (this.#splats.has(key)) continue;
          const tile = this.#tile(tx, tz, n);
          this.#splats.set(key, { rect: tile, data: this.#readSplat(tile) });
        }
      }
    }
  }

  #tile(tx: number, tz: number, limit: number): TerrainRect {
    return {
      x0: tx * STROKE_TILE,
      z0: tz * STROKE_TILE,
      x1: Math.min(limit, (tx + 1) * STROKE_TILE),
      z1: Math.min(limit, (tz + 1) * STROKE_TILE),
    };
  }

  #readSplat(tile: TerrainRect): Uint8Array {
    const { field } = this;
    const n = field.splatCells, planes = terrainPlanes(field.layers);
    const w = tile.x1 - tile.x0, h = tile.z1 - tile.z0;
    const data = new Uint8Array(planes * w * h * 4);
    for (let p = 0; p < planes; p++) {
      for (let z = 0; z < h; z++) {
        const from = p * n * n * 4 + ((tile.z0 + z) * n + tile.x0) * 4;
        data.set(field.splat.subarray(from, from + w * 4), (p * h + z) * w * 4);
      }
    }
    return data;
  }

  /** Put the field back as it was before the stroke began. */
  revert(): void {
    if (this.#done) return;
    this.#done = true;
    const { field, resource } = this;
    if (resource.field !== field) return;
    const n = field.splatCells, planes = terrainPlanes(field.layers);
    for (const { rect, data } of this.#heights.values()) {
      const w = rect.x1 - rect.x0;
      for (let z = rect.z0; z < rect.z1; z++) {
        field.heights.set(
          data.subarray((z - rect.z0) * w, (z - rect.z0 + 1) * w),
          z * field.stride + rect.x0,
        );
      }
      resource.markDirty(rect);
    }
    for (const { rect, data } of this.#splats.values()) {
      const w = rect.x1 - rect.x0, h = rect.z1 - rect.z0;
      for (let p = 0; p < planes; p++) {
        for (let z = 0; z < h; z++) {
          field.splat.set(
            data.subarray((p * h + z) * w * 4, (p * h + z + 1) * w * 4),
            p * n * n * 4 + ((rect.z0 + z) * n + rect.x0) * 4,
          );
        }
      }
      const k = field.cells / n;
      resource.markDirty(
        {
          x0: Math.floor(rect.x0 * k),
          z0: Math.floor(rect.z0 * k),
          x1: Math.ceil(rect.x1 * k),
          z1: Math.ceil(rect.z1 * k),
        },
        rect,
      );
    }
    this.#heights.clear();
    this.#splats.clear();
  }

  /** The stroke's tiles that differ now, as field tile keys. */
  #changedTiles(): number[] {
    const { field } = this;
    const columns = Math.ceil(field.stride / STROKE_TILE);
    const keys = new Set(this.#heights.keys());
    const n = field.splatCells, k = n / field.cells;
    for (const { rect } of this.#splats.values()) {
      // Every field tile whose splat texels overlap this splat tile.
      const first = Math.max(0, Math.floor(rect.x0 / k / STROKE_TILE) - 1);
      const last = Math.floor(rect.x1 / k / STROKE_TILE) + 1;
      const firstZ = Math.max(0, Math.floor(rect.z0 / k / STROKE_TILE) - 1);
      const lastZ = Math.floor(rect.z1 / k / STROKE_TILE) + 1;
      for (let tz = firstZ; tz <= Math.min(lastZ, columns - 1); tz++) {
        for (let tx = first; tx <= Math.min(last, columns - 1); tx++) {
          const tile = this.#tile(tx, tz, field.stride);
          if (rectsMeet(this.#splatRectOf(tile), rect)) {
            keys.add(tz * columns + tx);
          }
        }
      }
    }
    return [...keys].sort((a, b) => a - b);
  }

  #splatRectOf(tile: TerrainRect): TerrainRect {
    const { field } = this;
    const k = field.splatCells / field.cells;
    return {
      x0: Math.max(0, Math.floor(tile.x0 * k)),
      z0: Math.max(0, Math.floor(tile.z0 * k)),
      x1: Math.min(field.splatCells, Math.ceil(tile.x1 * k) + 1),
      z1: Math.min(field.splatCells, Math.ceil(tile.z1 * k) + 1),
    };
  }

  /** The tile as it was before the stroke: the field's current contents with
   * the saved originals laid over them. */
  #original(after: TerrainPatch, key: number): TerrainPatch {
    const before: TerrainPatch = {
      rect: after.rect,
      heights: after.heights.slice(),
      splatRect: after.splatRect,
      splat: after.splat.slice(),
    };
    const saved = this.#heights.get(key);
    if (saved) before.heights.set(saved.data);
    const r = before.splatRect;
    const rw = r.x1 - r.x0, rh = r.z1 - r.z0;
    const planes = terrainPlanes(this.field.layers);
    for (const { rect: s, data } of this.#splats.values()) {
      if (!rectsMeet(s, r)) continue;
      const x0 = Math.max(s.x0, r.x0), x1 = Math.min(s.x1, r.x1);
      const z0 = Math.max(s.z0, r.z0), z1 = Math.min(s.z1, r.z1);
      const sw = s.x1 - s.x0, sh = s.z1 - s.z0;
      for (let p = 0; p < planes; p++) {
        for (let z = z0; z < z1; z++) {
          const from = ((p * sh + (z - s.z0)) * sw + (x0 - s.x0)) * 4;
          before.splat.set(
            data.subarray(from, from + (x1 - x0) * 4),
            ((p * rh + (z - r.z0)) * rw + (x0 - r.x0)) * 4,
          );
        }
      }
    }
    return before;
  }

  /** End the stroke: commit every changed tile to the resource's history.
   * Returns the resource's new revision and the part of the height field
   * that changed (to refresh the collision grid), or null when nothing
   * changed. */
  finish(): { revision: number; area: TerrainRect | null } | null {
    if (this.#done) return null;
    this.#done = true;
    const { field, resource } = this;
    // The data was replaced (reloaded from disk) under the stroke: what it
    // changed went with the old copy.
    if (resource.field !== field) return null;
    const columns = Math.ceil(field.stride / STROKE_TILE);
    let committed = 0;
    for (const key of this.#changedTiles()) {
      const tx = key % columns, tz = Math.floor(key / columns);
      const after = readPatch(field, this.#tile(tx, tz, field.stride));
      const before = this.#original(after, key);
      if (
        sameBytes(before.heights, after.heights) &&
        sameBytes(before.splat, after.splat)
      ) continue;
      resource.commit(before, after);
      committed++;
    }
    this.#heights.clear();
    this.#splats.clear();
    return committed ? { revision: resource.revision, area: this.#area } : null;
  }
}
