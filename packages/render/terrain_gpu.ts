/**
 * GPU side of one terrain: the height, slope and splat textures with their
 * uploads, the layer texture arrays, the uniform and the quadtree selection.
 *
 * Heights are one `r32float` level. Slopes (`rg16float`, with a full mip chain
 * so distant ground is prefiltered) and splat weights (`rgba8unorm` array,
 * mipped) are derived on the CPU for exactly the rectangles that change.
 * Loading streams: an overview-resolution copy is shown first; once the field
 * is complete its tiles are uploaded nearest the camera first, a few per
 * frame (`Overlays.still` uploads everything at once, so captures are
 * complete and repeatable). Edits upload only their rectangle, immediately.
 */
import { type Mat4, terrainPlanes, type TerrainRect } from "@ink/geometry";
import { boundsInClip } from "./culling.ts";
import type { Core } from "./core.ts";
import { TextureUsage } from "./gpu.ts";
import {
  MAX_TERRAIN_LAYERS,
  TERRAIN_UNIFORM_FLOATS,
} from "./shaders/terrain.ts";
import { PATCH_CELLS } from "./shaders/terrain.ts";
import {
  TERRAIN_LEAF,
  TERRAIN_TILE,
  type TerrainResource,
} from "./terrain_store.ts";
import type { Camera, TerrainDraw } from "./types.ts";
import { kitOf } from "./terrain_pipelines.ts";

/** Edge of the layer texture arrays. */
export const LAYER_SIZE = 1024;
/** Tiles uploaded per frame while streaming. */
export const TILES_PER_FRAME = 3;

const mipCount = (size: number) => Math.floor(Math.log2(Math.max(1, size))) + 1;

// Half floats -------------------------------------------------------------------

const Half = (globalThis as unknown as {
  Float16Array?: new (buffer: ArrayBuffer) => {
    set(values: ArrayLike<number>): void;
  };
}).Float16Array;
const scratch = new Float32Array(1);
const scratchBits = new Uint32Array(scratch.buffer);
function halfBits(value: number): number {
  scratch[0] = value;
  const x = scratchBits[0];
  const sign = (x >>> 16) & 0x8000;
  const exponent = ((x >>> 23) & 0xff) - 127 + 15;
  const mantissa = x & 0x7fffff;
  if (exponent >= 31) return sign | 0x7c00;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    return sign | ((mantissa | 0x800000) >> (14 - exponent));
  }
  return sign | (exponent << 10) | (mantissa >> 13);
}
function toHalf(values: Float32Array, out: Uint16Array) {
  if (Half) new Half(out.buffer as ArrayBuffer).set(values);
  else for (let i = 0; i < values.length; i++) out[i] = halfBits(values[i]);
}

// CPU image pyramids ----------------------------------------------------------------

interface Level {
  width: number;
  height: number;
  data: Float32Array;
}

/** Slopes of the heightfield, two floats per texel, mipped. */
class SlopePyramid {
  levels: Level[] = [];
  constructor(size: number) {
    for (let w = size;; w = Math.max(1, w >> 1)) {
      this.levels.push({
        width: w,
        height: w,
        data: new Float32Array(w * w * 2),
      });
      if (w === 1) break;
    }
  }

  /** Recompute level 0 inside `rect` from the heights; returns the rectangle
   * of each level that changed. */
  update(
    heights: Float32Array,
    stride: number,
    rect: TerrainRect,
  ): TerrainRect[] {
    const l0 = this.levels[0];
    const x0 = Math.max(0, rect.x0 - 1), z0 = Math.max(0, rect.z0 - 1);
    const x1 = Math.min(stride, rect.x1 + 1),
      z1 = Math.min(stride, rect.z1 + 1);
    const last = stride - 1;
    for (let z = z0; z < z1; z++) {
      const zm = Math.max(0, z - 1) * stride,
        zp = Math.min(last, z + 1) * stride,
        zc = z * stride;
      for (let x = x0; x < x1; x++) {
        const xm = Math.max(0, x - 1), xp = Math.min(last, x + 1);
        const o = (z * stride + x) * 2;
        l0.data[o] = (heights[zc + xp] - heights[zc + xm]) * 0.5;
        l0.data[o + 1] = (heights[zp + x] - heights[zm + x]) * 0.5;
      }
    }
    const rects: TerrainRect[] = [{ x0, z0, x1, z1 }];
    for (let k = 1; k < this.levels.length; k++) {
      const prev = this.levels[k - 1], level = this.levels[k], r = rects[k - 1];
      const rx0 = Math.max(0, r.x0 >> 1), rz0 = Math.max(0, r.z0 >> 1);
      const rx1 = Math.min(level.width, (r.x1 + 1) >> 1),
        rz1 = Math.min(level.height, (r.z1 + 1) >> 1);
      for (let z = rz0; z < rz1; z++) {
        for (let x = rx0; x < rx1; x++) {
          const sx = Math.min(prev.width - 1, x * 2),
            sz = Math.min(prev.height - 1, z * 2);
          const sx1 = Math.min(prev.width - 1, sx + 1),
            sz1 = Math.min(prev.height - 1, sz + 1);
          for (let c = 0; c < 2; c++) {
            level.data[(z * level.width + x) * 2 + c] = (
              prev.data[(sz * prev.width + sx) * 2 + c] +
              prev.data[(sz * prev.width + sx1) * 2 + c] +
              prev.data[(sz1 * prev.width + sx) * 2 + c] +
              prev.data[(sz1 * prev.width + sx1) * 2 + c]
            ) * 0.25;
          }
        }
      }
      rects.push({ x0: rx0, z0: rz0, x1: rx1, z1: rz1 });
    }
    return rects;
  }
}

/** Mip levels of the splat map (level 0 is the field's own array). */
class SplatPyramid {
  levels: { width: number; height: number; data: Uint8Array }[] = [];
  constructor(
    readonly size: number,
    readonly planes: number,
    level0: Uint8Array,
  ) {
    this.levels.push({ width: size, height: size, data: level0 });
    for (let w = size; w > 1;) {
      w = Math.max(1, w >> 1);
      this.levels.push({
        width: w,
        height: w,
        data: new Uint8Array(w * w * 4 * planes),
      });
    }
  }

  update(rect: TerrainRect): TerrainRect[] {
    const rects: TerrainRect[] = [{ ...rect }];
    for (let k = 1; k < this.levels.length; k++) {
      const prev = this.levels[k - 1], level = this.levels[k], r = rects[k - 1];
      const rx0 = Math.max(0, r.x0 >> 1), rz0 = Math.max(0, r.z0 >> 1);
      const rx1 = Math.min(level.width, (r.x1 + 1) >> 1),
        rz1 = Math.min(level.height, (r.z1 + 1) >> 1);
      for (let p = 0; p < this.planes; p++) {
        const pb = p * prev.width * prev.height * 4,
          lb = p * level.width * level.height * 4;
        for (let z = rz0; z < rz1; z++) {
          for (let x = rx0; x < rx1; x++) {
            const sx = Math.min(prev.width - 1, x * 2),
              sz = Math.min(prev.height - 1, z * 2);
            const sx1 = Math.min(prev.width - 1, sx + 1),
              sz1 = Math.min(prev.height - 1, sz + 1);
            for (let c = 0; c < 4; c++) {
              level.data[lb + (z * level.width + x) * 4 + c] = (
                prev.data[pb + (sz * prev.width + sx) * 4 + c] +
                prev.data[pb + (sz * prev.width + sx1) * 4 + c] +
                prev.data[pb + (sz1 * prev.width + sx) * 4 + c] +
                prev.data[pb + (sz1 * prev.width + sx1) * 4 + c] + 2
              ) >> 2;
            }
          }
        }
      }
      rects.push({ x0: rx0, z0: rz0, x1: rx1, z1: rz1 });
    }
    return rects;
  }
}

// Terrain -----------------------------------------------------------------------------

interface Tile {
  x: number;
  z: number;
}

export interface NodeList {
  /** x, z, size (m), level of every selected patch. */
  data: number[];
  count: number;
}

export class TerrainGpu {
  height?: GPUTexture;
  slope?: GPUTexture;
  splat?: GPUTexture;
  albedo?: GPUTexture;
  data?: GPUTexture;
  readonly uniform: GPUBuffer;
  group?: GPUBindGroup;
  private cells = 0;
  private splatCells = 0;
  private planes = 0;
  private layerCount = -1;
  private slopes?: SlopePyramid;
  private splatLevels?: SplatPyramid;
  private pending: Tile[] = [];
  private seenVersion = -1;
  private overviewShown = false;
  private fieldShown = false;
  private layerKeys: string[] = [];
  private lastDraw?: TerrainDraw;
  private uniformKey = "";
  /** Bytes uploaded in the last update, for tests and tools. */
  uploaded = 0;
  /** Tiles still waiting to be uploaded. */
  get streaming(): number {
    return this.pending.length;
  }
  /** Layer textures still loading or not yet copied. */
  layersPending = false;
  /** Bumped when the bind group is rebuilt. */
  groupId = 0;

  constructor(private core: Core, readonly resource: TerrainResource) {
    this.uniform = core.device.createBuffer({
      label: "terrain",
      size: TERRAIN_UNIFORM_FLOATS * 4,
      usage: 64 | 8,
    });
  }

  get ready(): boolean {
    return this.resource.state === "overview" ||
      this.resource.state === "ready";
  }

  /** Whether every texture holds the final data. */
  get complete(): boolean {
    return this.fieldShown && this.pending.length === 0 && !this.layersPending;
  }

  // Updating ------------------------------------------------------------------------

  /** Bring the GPU copy up to date for this frame. */
  update(draw: TerrainDraw, camera: Camera, still: boolean) {
    this.uploaded = 0;
    this.lastDraw = draw;
    const r = this.resource;
    if (!this.ready) return;
    const header = r.header!;
    const planes = terrainPlanes(header.layers);
    if (
      this.cells !== header.cells || this.splatCells !== header.splatCells ||
      this.planes !== planes
    ) this.createTextures(header.cells, header.splatCells, planes);
    if (r.state === "overview" && !this.overviewShown && r.overview) {
      this.showOverview(r.overview, header.cells, header.overviewCells);
      this.overviewShown = true;
    }
    if (r.state === "ready" && r.field) {
      if (this.seenVersion !== r.version) {
        if (!this.fieldShown || !this.slopes) this.beginStreaming();
        this.seenVersion = r.version;
        this.applyDirty(still);
      }
      const budget = still ? Infinity : TILES_PER_FRAME;
      if (this.pending.length) {
        const at = [
          (camera.position[0] - draw.position[0]) / draw.size + 0.5,
          (camera.position[2] - draw.position[2]) / draw.size + 0.5,
        ];
        const per = TERRAIN_TILE / this.cells;
        this.pending.sort((a, b) =>
          Math.hypot((a.x + 0.5) * per - at[0], (a.z + 0.5) * per - at[1]) -
          Math.hypot((b.x + 0.5) * per - at[0], (b.z + 0.5) * per - at[1])
        );
        for (let i = 0; i < budget && this.pending.length; i++) {
          const tile = this.pending.shift()!;
          this.uploadTile(tile);
        }
        if (!this.pending.length) this.fieldShown = true;
      }
    }
    this.updateLayers(draw);
    this.writeUniform(draw);
  }

  private createTextures(cells: number, splatCells: number, planes: number) {
    this.releaseData();
    const device = this.core.device;
    const stride = cells + 1;
    this.cells = cells;
    this.splatCells = splatCells;
    this.planes = planes;
    this.height = device.createTexture({
      label: "terrain heights",
      size: [stride, stride],
      format: "r32float",
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
    });
    this.slope = device.createTexture({
      label: "terrain slopes",
      size: [stride, stride],
      format: "rg16float",
      mipLevelCount: mipCount(stride),
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
    });
    this.splat = device.createTexture({
      label: "terrain splat",
      size: [splatCells, splatCells, planes],
      format: "rgba8unorm",
      mipLevelCount: mipCount(splatCells),
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
    });
    this.slopes = undefined;
    this.splatLevels = undefined;
    this.overviewShown = false;
    this.fieldShown = false;
    this.seenVersion = -1;
    this.pending = [];
    this.group = undefined;
    this.layerKeys = [];
    this.uniformKey = "";
  }

  private showOverview(
    overview: Float32Array,
    cells: number,
    overviewCells: number,
  ) {
    // Bilinear upsample of the decimated field, one row band at a time.
    const stride = cells + 1;
    const n = overviewCells + 1;
    const k = overviewCells / cells;
    const rows = 128;
    const band = new Float32Array(stride * rows);
    for (let z0 = 0; z0 < stride; z0 += rows) {
      const h = Math.min(rows, stride - z0);
      for (let z = 0; z < h; z++) {
        const fz = Math.min((z0 + z) * k, overviewCells - 1e-6);
        const iz = Math.floor(fz), tz = fz - iz;
        for (let x = 0; x < stride; x++) {
          const fx = Math.min(x * k, overviewCells - 1e-6);
          const ix = Math.floor(fx), tx = fx - ix;
          const a = overview[iz * n + ix], b = overview[iz * n + ix + 1];
          const c = overview[(iz + 1) * n + ix],
            d = overview[(iz + 1) * n + ix + 1];
          band[z * stride + x] = (a + (b - a) * tx) * (1 - tz) +
            (c + (d - c) * tx) * tz;
        }
      }
      this.core.device.queue.writeTexture(
        { texture: this.height!, origin: [0, z0] },
        band as Float32Array<ArrayBuffer>,
        { bytesPerRow: stride * 4 },
        [stride, h],
      );
    }
    this.uploaded += stride * stride * 4;
  }

  private beginStreaming() {
    const field = this.resource.field!;
    this.slopes = new SlopePyramid(field.stride);
    this.splatLevels = new SplatPyramid(
      field.splatCells,
      this.planes,
      field.splat,
    );
    this.pending = [];
    const tiles = Math.ceil(field.cells / TERRAIN_TILE);
    for (let z = 0; z < tiles; z++) {
      for (let x = 0; x < tiles; x++) this.pending.push({ x, z });
    }
    this.fieldShown = false;
    // Edits made before the first upload are part of the data already.
    this.resource.takeDirty();
  }

  /** Edits and reloads since the last frame. */
  private applyDirty(still: boolean) {
    const r = this.resource;
    const { heights, splat } = r.takeDirty();
    if (!this.slopes) return;
    const field = r.field!;
    if (heights) {
      const tiles = (Math.ceil((heights.x1 - heights.x0) / TERRAIN_TILE) + 1) *
        (Math.ceil((heights.z1 - heights.z0) / TERRAIN_TILE) + 1);
      if (tiles > 6 && !still && this.fieldShown) {
        // A reload: stream it like the first load.
        this.pending = [];
        const count = Math.ceil(field.cells / TERRAIN_TILE);
        for (let z = 0; z < count; z++) {
          for (let x = 0; x < count; x++) this.pending.push({ x, z });
        }
        this.fieldShown = false;
      } else if (this.fieldShown || still) {
        this.uploadHeights(heights);
        if (splat) this.uploadSplat(splat);
        return;
      }
    }
    if (splat && this.fieldShown) this.uploadSplat(splat);
  }

  private uploadTile(tile: Tile) {
    const field = this.resource.field!;
    const x0 = tile.x * TERRAIN_TILE, z0 = tile.z * TERRAIN_TILE;
    const rect = {
      x0,
      z0,
      x1: Math.min(field.stride, x0 + TERRAIN_TILE + 1),
      z1: Math.min(field.stride, z0 + TERRAIN_TILE + 1),
    };
    this.uploadHeights(rect);
    const k = field.splatCells / field.cells;
    this.uploadSplat({
      x0: Math.floor(x0 * k),
      z0: Math.floor(z0 * k),
      x1: Math.min(field.splatCells, Math.ceil((x0 + TERRAIN_TILE) * k) + 1),
      z1: Math.min(field.splatCells, Math.ceil((z0 + TERRAIN_TILE) * k) + 1),
    });
  }

  private uploadHeights(area: TerrainRect) {
    const field = this.resource.field!;
    const queue = this.core.device.queue;
    const rect = {
      x0: Math.max(0, area.x0),
      z0: Math.max(0, area.z0),
      x1: Math.min(field.stride, area.x1),
      z1: Math.min(field.stride, area.z1),
    };
    const w = rect.x1 - rect.x0, h = rect.z1 - rect.z0;
    if (w <= 0 || h <= 0) return;
    // Hand the driver only the rows it needs, not the whole field.
    const first = rect.z0 * field.stride + rect.x0;
    queue.writeTexture(
      { texture: this.height!, origin: [rect.x0, rect.z0] },
      field.heights.subarray(
        first,
        first + (h - 1) * field.stride + w,
      ) as Float32Array<ArrayBuffer>,
      { bytesPerRow: field.stride * 4 },
      [w, h],
    );
    this.uploaded += w * h * 4;
    const rects = this.slopes!.update(field.heights, field.stride, rect);
    for (let k = 0; k < rects.length; k++) {
      const r = rects[k], level = this.slopes!.levels[k];
      const lw = r.x1 - r.x0, lh = r.z1 - r.z0;
      if (lw <= 0 || lh <= 0) continue;
      const source = new Float32Array(lw * lh * 2);
      for (let z = 0; z < lh; z++) {
        const from = ((r.z0 + z) * level.width + r.x0) * 2;
        source.set(level.data.subarray(from, from + lw * 2), z * lw * 2);
      }
      const packed = new Uint16Array(source.length);
      toHalf(source, packed);
      queue.writeTexture(
        { texture: this.slope!, mipLevel: k, origin: [r.x0, r.z0] },
        packed,
        { bytesPerRow: lw * 4 },
        [lw, lh],
      );
      this.uploaded += packed.byteLength;
    }
  }

  private uploadSplat(area: TerrainRect) {
    const levels = this.splatLevels!;
    const queue = this.core.device.queue;
    const rect = {
      x0: Math.max(0, area.x0),
      z0: Math.max(0, area.z0),
      x1: Math.min(this.splatCells, area.x1),
      z1: Math.min(this.splatCells, area.z1),
    };
    if (rect.x1 <= rect.x0 || rect.z1 <= rect.z0) return;
    const rects = levels.update(rect);
    for (let k = 0; k < rects.length; k++) {
      const r = rects[k], level = levels.levels[k];
      const w = r.x1 - r.x0, h = r.z1 - r.z0;
      if (w <= 0 || h <= 0) continue;
      for (let p = 0; p < this.planes; p++) {
        const base = p * level.width * level.height * 4 +
          (r.z0 * level.width + r.x0) * 4;
        queue.writeTexture(
          { texture: this.splat!, mipLevel: k, origin: [r.x0, r.z0, p] },
          level.data.subarray(
            base,
            base + ((h - 1) * level.width + w) * 4,
          ) as Uint8Array<ArrayBuffer>,
          { bytesPerRow: level.width * 4 },
          [w, h],
        );
        this.uploaded += w * h * 4;
      }
    }
  }

  // Layers ------------------------------------------------------------------------------

  private updateLayers(draw: TerrainDraw) {
    const count = Math.min(MAX_TERRAIN_LAYERS, draw.layers.length);
    const { device, assets } = this.core;
    if (count !== this.layerCount || !this.albedo) {
      this.albedo?.destroy();
      this.data?.destroy();
      const n = Math.max(1, count);
      const usage = TextureUsage.TEXTURE_BINDING |
        TextureUsage.RENDER_ATTACHMENT |
        TextureUsage.COPY_DST;
      this.albedo = device.createTexture({
        label: "terrain albedo layers",
        size: [LAYER_SIZE, LAYER_SIZE, n],
        format: "rgba8unorm-srgb",
        mipLevelCount: mipCount(LAYER_SIZE),
        usage,
      });
      this.data = device.createTexture({
        label: "terrain data layers",
        size: [LAYER_SIZE, LAYER_SIZE, 2 * n],
        format: "rgba8unorm",
        mipLevelCount: mipCount(LAYER_SIZE),
        usage,
      });
      this.layerCount = count;
      this.layerKeys = [];
      this.group = undefined;
    }
    const kit = kitOf(this.core);
    const encoder = device.createCommandEncoder({ label: "terrain layers" });
    let work = false;
    let waiting = false;
    const blit = (
      target: GPUTexture,
      format: GPUTextureFormat,
      layer: number,
      path: string | undefined,
      kind: "color" | "normal" | "orm",
    ) => {
      const tex = assets.getTexture(path, kind);
      const key = `${layer}:${kind}:${tex.id}`;
      const slot = layer + (format === "rgba8unorm-srgb" ? 0 : 1000);
      if (path && tex.id === assets.white.id && kind === "color") {
        waiting = true;
      }
      if (this.layerKeys[slot] === key) return;
      this.layerKeys[slot] = key;
      work = true;
      const view = (mip: number) =>
        target.createView({
          dimension: "2d",
          baseMipLevel: mip,
          mipLevelCount: 1,
          baseArrayLayer: layer,
          arrayLayerCount: 1,
        });
      let source = tex.texture.createView();
      for (let mip = 0; mip < mipCount(LAYER_SIZE); mip++) {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: view(mip),
            loadOp: "clear",
            storeOp: "store",
            clearValue: [0, 0, 0, 0],
          }],
        });
        pass.setPipeline(kit.mip(format));
        pass.setBindGroup(
          0,
          device.createBindGroup({
            layout: this.core.pipelines.mipLayout,
            entries: [
              { binding: 0, resource: source },
              { binding: 1, resource: kit.layerSampler },
            ],
          }),
        );
        pass.draw(3);
        pass.end();
        source = target.createView({
          dimension: "2d",
          baseMipLevel: mip,
          mipLevelCount: 1,
          baseArrayLayer: layer,
          arrayLayerCount: 1,
        });
      }
    };
    for (let i = 0; i < Math.max(1, count); i++) {
      const layer = draw.layers[i];
      blit(this.albedo!, "rgba8unorm-srgb", i, layer?.albedo, "color");
      blit(this.data!, "rgba8unorm", 2 * i, layer?.normal, "normal");
      blit(this.data!, "rgba8unorm", 2 * i + 1, layer?.orm, "orm");
    }
    this.layersPending = waiting;
    if (work) {
      device.queue.submit([encoder.finish()]);
      this.group = undefined;
    }
  }

  // Binding -----------------------------------------------------------------------------

  private writeUniform(draw: TerrainDraw) {
    const header = this.resource.header!;
    const count = Math.min(MAX_TERRAIN_LAYERS, draw.layers.length);
    const f = new Float32Array(TERRAIN_UNIFORM_FLOATS);
    const bits = new Uint32Array(f.buffer);
    f.set([draw.position[0], draw.position[1], draw.position[2]], 0);
    bits[3] = draw.entity;
    const factor = Math.max(1.5, draw.lodDistance / PATCH_CELLS);
    f.set([draw.size, header.cells, draw.heightScale, factor], 4);
    f.set([
      draw.detail.amplitude,
      draw.detail.wavelength,
      draw.detail.octaves,
      0,
    ], 8);
    bits[11] = draw.detail.seed >>> 0;
    f.set([count, draw.blendHeight, this.planes, 0], 12);
    for (let i = 0; i < MAX_TERRAIN_LAYERS; i++) {
      const l = draw.layers[i];
      const tint = l
        ? l.color.map((c, k) => (k < 3 ? srgbToLinear(c) : c))
        : [1, 1, 1];
      f.set([tint[0], tint[1], tint[2], l ? 1 / l.tiling : 1], 16 + i * 4);
    }
    const key = Array.from(f).join(",");
    if (key !== this.uniformKey) {
      this.uniformKey = key;
      this.core.device.queue.writeBuffer(this.uniform, 0, f);
    }
  }

  /** Group 1 of the terrain pipelines. */
  bindGroup(): GPUBindGroup {
    if (!this.group) {
      const kit = kitOf(this.core);
      this.group = this.core.device.createBindGroup({
        label: "terrain",
        layout: kit.terrainLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: this.height!.createView() },
          { binding: 2, resource: this.slope!.createView() },
          {
            binding: 3,
            resource: this.splat!.createView({ dimension: "2d-array" }),
          },
          {
            binding: 4,
            resource: this.albedo!.createView({ dimension: "2d-array" }),
          },
          {
            binding: 5,
            resource: this.data!.createView({ dimension: "2d-array" }),
          },
          { binding: 6, resource: kit.layerSampler },
          { binding: 7, resource: kit.mapSampler },
        ],
      });
      this.groupId++;
    }
    return this.group;
  }

  // Selection -----------------------------------------------------------------------------

  /** World-space bounds of the whole terrain, for culling and shadows. */
  worldBounds(draw: TerrainDraw): { min: number[]; max: number[] } {
    const [lo, hi] = this.resource.boundsOf(0, 0, 1 << 20, 1 << 20);
    const margin = draw.detail.amplitude * 1.05;
    const s = draw.heightScale;
    return {
      min: [
        draw.position[0] - draw.size / 2,
        draw.position[1] + Math.min(lo * s, hi * s) - margin,
        draw.position[2] - draw.size / 2,
      ],
      max: [
        draw.position[0] + draw.size / 2,
        draw.position[1] + Math.max(lo * s, hi * s) + margin,
        draw.position[2] + draw.size / 2,
      ],
    };
  }

  /**
   * Choose the patches to draw: a quadtree refined by distance to the camera
   * (a patch of level L stays whole while it is farther than `factor` x its
   * size), culled by `cull` (a clip matrix) when given. Appends x, z, size,
   * level quadruples to `out.data`.
   */
  select(draw: TerrainDraw, camera: Camera, cull: Mat4 | null, out: NodeList) {
    const r = this.resource;
    const header = r.header;
    if (!header) return;
    const cs = draw.size / header.cells;
    const leaf = PATCH_CELLS * cs;
    const top = Math.max(0, Math.ceil(Math.log2(header.cells / PATCH_CELLS)));
    const rootSize = leaf * 2 ** top;
    const factor = Math.max(1.5, draw.lodDistance / PATCH_CELLS);
    const half = draw.size / 2;
    const margin = draw.detail.amplitude * 1.05;
    const s = draw.heightScale;
    const cx = camera.position[0] - draw.position[0],
      cy = camera.position[1] - draw.position[1],
      cz = camera.position[2] - draw.position[2];
    const cellsPerLeaf = TERRAIN_LEAF;
    const visit = (x: number, z: number, size: number, level: number) => {
      if (x >= half || z >= half || x + size <= -half || z + size <= -half) {
        return;
      }
      // Leaf-grid range covered by this node, clamped to the field.
      const per = size / cs / cellsPerLeaf;
      const lx = Math.floor((x + half) / cs / cellsPerLeaf);
      const lz = Math.floor((z + half) / cs / cellsPerLeaf);
      const [lo, hi] = r.boundsOf(
        lx,
        lz,
        lx + Math.max(1, Math.ceil(per)),
        lz + Math.max(1, Math.ceil(per)),
      );
      const y0 = Math.min(lo * s, hi * s) - margin,
        y1 = Math.max(lo * s, hi * s) + margin;
      if (cull) {
        const box = {
          min: [
            draw.position[0] + x,
            draw.position[1] + y0,
            draw.position[2] + z,
          ] as [number, number, number],
          max: [
            draw.position[0] + x + size,
            draw.position[1] + y1,
            draw.position[2] + z + size,
          ] as [number, number, number],
        };
        if (!boundsInClip(box, cull)) return;
      }
      const dx = Math.max(x - cx, 0, cx - (x + size));
      const dz = Math.max(z - cz, 0, cz - (z + size));
      const dy = Math.max(y0 - cy, 0, cy - y1);
      const d = Math.hypot(dx, dy, dz);
      if (level === 0 || d >= factor * size) {
        out.data.push(x, z, size, level);
        out.count++;
        return;
      }
      const h = size / 2;
      visit(x, z, h, level - 1);
      visit(x + h, z, h, level - 1);
      visit(x, z + h, h, level - 1);
      visit(x + h, z + h, h, level - 1);
    };
    visit(-rootSize / 2, -rootSize / 2, rootSize, top);
  }

  releaseData() {
    this.height?.destroy();
    this.slope?.destroy();
    this.splat?.destroy();
    this.height = this.slope = this.splat = undefined;
  }

  dispose() {
    this.releaseData();
    this.albedo?.destroy();
    this.data?.destroy();
    this.uniform.destroy();
  }
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
