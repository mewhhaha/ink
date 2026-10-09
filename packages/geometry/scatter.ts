/**
 * Instance placements for scatter layers (trees, rocks, grass): a flat list of
 * `[x, y, z, yaw, scale, tint]` records in the scatter entity's frame, stored in
 * a `*.scatter` file. A hundred thousand placements are 2.4 MB; the world
 * packet never sees them. With `follow_terrain` the renderer replaces `y` by
 * the ground height plus `y`, so sculpting moves the instances with the ground.
 *
 * File (little endian): "INKS", version, count, revision, then count * 6 f32.
 * Records are stored sorted by chunk (`SCATTER_CHUNK` metres square, row
 * major from the -x/-z corner of the occupied area) so a loader can stream
 * them chunk by chunk.
 */

const MAGIC = 0x534b4e49; // "INKS"
export const SCATTER_VERSION = 1;
export const SCATTER_FLOATS = 6;
export const SCATTER_CHUNK = 128;

export interface Placement {
  x: number;
  y: number;
  z: number;
  /** Radians around +Y. */
  yaw: number;
  scale: number;
  /** 0..1 variation for tinting. */
  tint: number;
}

export class ScatterSet {
  revision = 0;
  /** `count * SCATTER_FLOATS` values; capacity may exceed `count`. */
  data: Float32Array;
  count = 0;

  constructor(capacity = 64) {
    this.data = new Float32Array(Math.max(1, capacity) * SCATTER_FLOATS);
  }

  static from(data: Float32Array, revision = 0): ScatterSet {
    const set = new ScatterSet(0);
    set.data = data;
    set.count = Math.floor(data.length / SCATTER_FLOATS);
    set.revision = revision;
    return set;
  }

  static parse(source: ArrayBuffer | Uint8Array): ScatterSet {
    const bytes = source instanceof Uint8Array
      ? source
      : new Uint8Array(source);
    if (bytes.byteLength < 16) throw new Error("scatter file is truncated");
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.getUint32(0, true) !== MAGIC) {
      throw new Error("not a scatter file (bad magic)");
    }
    if (v.getUint32(4, true) !== SCATTER_VERSION) {
      throw new Error(`unsupported scatter version ${v.getUint32(4, true)}`);
    }
    const count = v.getUint32(8, true);
    if (bytes.byteLength < 16 + count * SCATTER_FLOATS * 4) {
      throw new Error("scatter file is truncated");
    }
    const data = new Float32Array(count * SCATTER_FLOATS);
    new Uint8Array(data.buffer).set(
      bytes.subarray(16, 16 + data.byteLength),
    );
    return ScatterSet.from(data, v.getUint32(12, true));
  }

  /** The file, records sorted by chunk. */
  serialize(): Uint8Array {
    this.sort();
    const out = new Uint8Array(16 + this.count * SCATTER_FLOATS * 4);
    const v = new DataView(out.buffer);
    v.setUint32(0, MAGIC, true);
    v.setUint32(4, SCATTER_VERSION, true);
    v.setUint32(8, this.count, true);
    v.setUint32(12, this.revision, true);
    out.set(
      new Uint8Array(
        this.data.buffer,
        this.data.byteOffset,
        this.count * SCATTER_FLOATS * 4,
      ),
      16,
    );
    return out;
  }

  get(index: number): Placement {
    const o = index * SCATTER_FLOATS, d = this.data;
    return {
      x: d[o],
      y: d[o + 1],
      z: d[o + 2],
      yaw: d[o + 3],
      scale: d[o + 4],
      tint: d[o + 5],
    };
  }

  add(p: Placement): number {
    if ((this.count + 1) * SCATTER_FLOATS > this.data.length) {
      const grown = new Float32Array(
        Math.max(64, this.count * 2) * SCATTER_FLOATS,
      );
      grown.set(this.data.subarray(0, this.count * SCATTER_FLOATS));
      this.data = grown;
    }
    this.data.set(
      [p.x, p.y, p.z, p.yaw, p.scale, p.tint],
      this.count * SCATTER_FLOATS,
    );
    return this.count++;
  }

  /** Remove every placement `keep` rejects; returns the removed ones. */
  filter(keep: (p: Placement, index: number) => boolean): Placement[] {
    const removed: Placement[] = [];
    let out = 0;
    for (let i = 0; i < this.count; i++) {
      const p = this.get(i);
      if (keep(p, i)) {
        if (out !== i) {
          this.data.copyWithin(
            out * SCATTER_FLOATS,
            i * SCATTER_FLOATS,
            (i + 1) * SCATTER_FLOATS,
          );
        }
        out++;
      } else removed.push(p);
    }
    this.count = out;
    return removed;
  }

  /** Bounds in x and z of all placements, or null when empty. */
  extent(): { minX: number; minZ: number; maxX: number; maxZ: number } | null {
    if (!this.count) return null;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const x = this.data[i * SCATTER_FLOATS],
        z = this.data[i * SCATTER_FLOATS + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    return { minX, minZ, maxX, maxZ };
  }

  /** Reorder records by chunk (row-major), stable within a chunk. */
  sort(): void {
    const extent = this.extent();
    if (!extent) return;
    const columns = Math.floor((extent.maxX - extent.minX) / SCATTER_CHUNK) + 1;
    const key = new Float64Array(this.count);
    const order = new Uint32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const cx = Math.floor(
        (this.data[i * SCATTER_FLOATS] - extent.minX) / SCATTER_CHUNK,
      );
      const cz = Math.floor(
        (this.data[i * SCATTER_FLOATS + 2] - extent.minZ) / SCATTER_CHUNK,
      );
      key[i] = cz * columns + cx;
      order[i] = i;
    }
    order.sort((a, b) => key[a] - key[b] || a - b);
    const sorted = new Float32Array(this.count * SCATTER_FLOATS);
    for (let i = 0; i < this.count; i++) {
      sorted.set(
        this.data.subarray(
          order[i] * SCATTER_FLOATS,
          (order[i] + 1) * SCATTER_FLOATS,
        ),
        i * SCATTER_FLOATS,
      );
    }
    this.data = sorted;
  }
}
