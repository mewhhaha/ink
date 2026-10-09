/**
 * The 2D layer of a view: sprites, tile maps and SDF text. `prepare` lays the
 * scene's 2D content out (see layout2d.ts) and uploads it; `draw` records the
 * draws into the overlay pass, in painter's order, with 2D lighting and
 * optional tile shadows. Nothing here is game state: textures, buffers and
 * caches belong to the view.
 */
import { srgbToLinear } from "./gpu.ts";
import {
  BufferUsage,
  DEPTH_FORMAT,
  GrowBuffer,
  OVERLAY_FORMAT,
  SAMPLES,
  ShaderStage,
  TextureUsage,
} from "./gpu.ts";
import type { Core } from "./core.ts";
import { fontAtlas, OUTLINE_PER_PIXEL } from "./font.ts";
import { type Item2d, layout2d, type TileItem } from "./layout2d.ts";
import { MAX_LIGHTS_2D, spriteShader } from "./shaders/sprites.ts";
import type { Light2dDraw, RenderScene } from "./types.ts";
import { TILE_SOLID } from "@ink/schema";

const V = ShaderStage.VERTEX, F = ShaderStage.FRAGMENT;
const QUAD_FLOATS = 32;

const FLIP_X = 1, FLIP_Y = 2, LIT = 4, SMOOTH = 8, NORMALS = 16;

interface Shared {
  layer: GPUBindGroupLayout;
  image: GPUBindGroupLayout;
  sprite: GPURenderPipeline;
  tile: GPURenderPipeline;
  text: GPURenderPipeline;
  nearest: GPUSampler;
  smooth: GPUSampler;
  dummyTiles: GPUTextureView;
  dummyRects: GPUBuffer;
  dummyOccluder: GPUTextureView;
  glyphs?: { id: number; texture: GPUTexture; view: GPUTextureView };
}

const shared = new WeakMap<GPUDevice, Shared>();

const ids = new WeakMap<object, number>();
let nextId = 1;
/** A stable number for a GPU object, to key bind groups. */
function idOf(object: object): number {
  let id = ids.get(object);
  if (!id) ids.set(object, id = nextId++);
  return id;
}

function sharedFor(core: Core): Shared {
  const found = shared.get(core.device);
  if (found) return found;
  const { device, pipelines } = core;
  const layer = device.createBindGroupLayout({
    label: "layer2d",
    entries: [
      { binding: 0, visibility: F, buffer: { type: "uniform" } },
      { binding: 1, visibility: F, buffer: { type: "read-only-storage" } },
      {
        binding: 2,
        visibility: F,
        texture: { sampleType: "unfilterable-float" },
      },
      { binding: 3, visibility: V | F, buffer: { type: "read-only-storage" } },
    ],
  });
  const image = device.createBindGroupLayout({
    label: "image2d",
    entries: [
      { binding: 0, visibility: F, sampler: { type: "filtering" } },
      { binding: 1, visibility: F, sampler: { type: "filtering" } },
      { binding: 2, visibility: F, texture: { sampleType: "float" } },
      { binding: 3, visibility: F, texture: { sampleType: "float" } },
      { binding: 4, visibility: F, texture: { sampleType: "uint" } },
      { binding: 5, visibility: F, buffer: { type: "read-only-storage" } },
    ],
  });
  const module = device.createShaderModule({
    label: "sprites",
    code: spriteShader,
  });
  const layout = device.createPipelineLayout({
    bindGroupLayouts: [pipelines.frameLayout, layer, image],
  });
  const pipeline = (label: string, fragment: string) =>
    device.createRenderPipeline({
      label,
      layout,
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: fragment,
        targets: [{
          format: OVERLAY_FORMAT,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        }],
      },
      primitive: { cullMode: "none" },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
      multisample: { count: SAMPLES },
    });
  const one = (
    format: GPUTextureFormat,
    bytes: Uint8Array,
  ): GPUTextureView => {
    const texture = device.createTexture({
      label: "dummy2d",
      size: [1, 1],
      format,
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, bytes as BufferSource, {
      bytesPerRow: bytes.length,
    }, [1, 1]);
    return texture.createView();
  };
  const dummyRects = device.createBuffer({
    label: "dummy rects",
    size: 16,
    usage: BufferUsage.STORAGE,
  });
  const made: Shared = {
    layer,
    image,
    sprite: pipeline("sprites", "fsSprite"),
    tile: pipeline("tiles", "fsTile"),
    text: pipeline("text", "fsText"),
    nearest: device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
    }),
    smooth: device.createSampler({ magFilter: "linear", minFilter: "linear" }),
    dummyTiles: one("r16uint", new Uint8Array(2)),
    dummyRects,
    dummyOccluder: one("r8unorm", new Uint8Array(1)),
  };
  shared.set(device, made);
  return made;
}

/** The SDF font as a texture, uploaded once per device. */
function glyphTexture(core: Core, s: Shared) {
  if (s.glyphs) return s.glyphs;
  const atlas = fontAtlas();
  const texture = core.device.createTexture({
    label: "sdf-font",
    size: [atlas.width, atlas.height],
    format: "rgba8unorm",
    usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
  });
  core.device.queue.writeTexture(
    { texture },
    atlas.data as BufferSource,
    { bytesPerRow: atlas.width * 4 },
    [atlas.width, atlas.height],
  );
  s.glyphs = { id: -1, texture, view: texture.createView() };
  return s.glyphs;
}

interface Run {
  pipeline: GPURenderPipeline;
  group: GPUBindGroup;
  first: number;
  count: number;
}

interface TileTexture {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  data: Uint16Array;
  used: number;
}

export class Sprites2d {
  /** Resolved items of the last prepared frame, back to front. */
  items: Item2d[] = [];
  private s: Shared;
  private quads: GrowBuffer;
  private lightBuffer: GPUBuffer;
  private envBuffer: GPUBuffer;
  private runs: Run[] = [];
  private layerGroup?: GPUBindGroup;
  private groups = new Map<string, GPUBindGroup>();
  private tiles = new Map<number, TileTexture>();
  private rects = new Map<string, GPUBuffer>();
  private occluder?: {
    texture: GPUTexture;
    view: GPUTextureView;
    width: number;
    height: number;
    data: Uint8Array;
  };
  private frame = 0;

  constructor(private core: Core) {
    this.s = sharedFor(core);
    const { device } = core;
    this.quads = new GrowBuffer(
      device,
      BufferUsage.STORAGE,
      "quads2d",
      QUAD_FLOATS * 4 * 64,
    );
    this.lightBuffer = device.createBuffer({
      label: "lights2d",
      size: MAX_LIGHTS_2D * 64,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
    this.envBuffer = device.createBuffer({
      label: "env2d",
      size: 64,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
  }

  /** Number of items drawn by the last `prepare`. */
  get count(): number {
    return this.items.length;
  }

  /** Lay the scene out and upload everything `draw` needs. */
  prepare(scene: RenderScene): number {
    const { device, assets } = this.core;
    this.frame++;
    this.items = layout2d(scene, assets);
    this.runs = [];
    const floats = new Float32Array(
      Math.max(
        1,
        this.items.reduce(
          (n, item) =>
            n + (item.kind === "text" ? item.glyphs.length : 1) * QUAD_FLOATS,
          0,
        ),
      ),
    );
    let quad = 0;
    const push = (
      matrix: Float32Array,
      rect: ArrayLike<number>,
      tint: ArrayLike<number>,
      p0: [number, number, number, number],
      p1: [number, number, number, number],
    ) => {
      const o = quad * QUAD_FLOATS;
      floats.set(matrix, o);
      floats.set(rect as ArrayLike<number>, o + 16);
      floats.set(tint as ArrayLike<number>, o + 20);
      floats.set(p0, o + 24);
      floats.set(p1, o + 28);
      return quad++;
    };
    const white = assets.getTexture(undefined);
    let run: (Run & { key: string }) | undefined;
    const add = (
      key: string,
      pipeline: GPURenderPipeline,
      group: () => GPUBindGroup,
      count: number,
      first: number,
    ) => {
      if (run && run.key === key && run.pipeline === pipeline) {
        run.count += count;
        return;
      }
      run = { key, pipeline, group: this.group(key, group), first, count };
      this.runs.push(run);
    };
    const usedTiles = new Set<number>();
    for (const item of this.items) {
      if (item.kind === "sprite") {
        const base = assets.getTexture(item.image);
        const normal = item.normals
          ? assets.getTexture(item.normals, "normal")
          : assets.flatNormal;
        const flags = (item.flipX ? FLIP_X : 0) | (item.flipY ? FLIP_Y : 0) |
          (item.lit ? LIT : 0) | (item.smooth ? SMOOTH : 0) |
          (item.normals ? NORMALS : 0);
        const at = push(item.matrix, item.rect, item.color, [flags, 0, 0, 0], [
          0,
          0,
          0,
          0,
        ]);
        add(
          `s${base.id}:${normal.id}`,
          this.s.sprite,
          () => this.imageGroup(base.texture, normal.texture),
          1,
          at,
        );
      } else if (item.kind === "tilemap") {
        const base = assets.getTexture(item.image);
        const normal = item.normals
          ? assets.getTexture(item.normals, "normal")
          : assets.flatNormal;
        const tex = this.tileTexture(item);
        usedTiles.add(item.entity);
        const rects = this.rectBuffer(item);
        const flags = (item.lit ? LIT : 0) | (item.normals ? NORMALS : 0);
        const at = push(
          item.matrix,
          [0, 0, 0, 0],
          item.color,
          [flags, 0, 0, 0],
          [
            item.width,
            item.height,
            0,
            0,
          ],
        );
        add(
          `t${idOf(tex.view)}:${idOf(rects)}:${base.id}:${normal.id}`,
          this.s.tile,
          () => this.imageGroup(base.texture, normal.texture, tex.view, rects),
          1,
          at,
        );
      } else {
        const glyphs = glyphTexture(this.core, this.s);
        const first = quad;
        for (const g of item.glyphs) {
          push(g.matrix, g.rect, item.color, [
            0,
            Math.min(0.45, item.outline * OUTLINE_PER_PIXEL),
            0,
            0,
          ], [
            ...item.outlineColor,
          ] as [number, number, number, number]);
        }
        if (item.glyphs.length) {
          add(
            "text",
            this.s.text,
            () => this.imageGroup(glyphs.texture, white.texture),
            item.glyphs.length,
            first,
          );
        }
      }
    }
    this.sweepTiles(usedTiles);
    if (this.quads.reserve(floats.byteLength)) this.layerGroup = undefined;
    device.queue.writeBuffer(
      this.quads.buffer,
      0,
      floats,
      0,
      quad * QUAD_FLOATS,
    );
    this.uploadLighting(scene);
    this.layerGroup = device.createBindGroup({
      label: "layer2d",
      layout: this.s.layer,
      entries: [
        { binding: 0, resource: { buffer: this.envBuffer } },
        { binding: 1, resource: { buffer: this.lightBuffer } },
        {
          binding: 2,
          resource: this.occluder?.view ?? this.s.dummyOccluder,
        },
        { binding: 3, resource: { buffer: this.quads.buffer } },
      ],
    });
    return this.items.length;
  }

  /** Record the draws into the overlay pass (group 0 is already bound). */
  draw(pass: GPURenderPassEncoder): void {
    if (!this.layerGroup) return;
    pass.setBindGroup(1, this.layerGroup);
    for (const run of this.runs) {
      pass.setPipeline(run.pipeline);
      pass.setBindGroup(2, run.group);
      pass.draw(6, run.count, 0, run.first);
    }
  }

  // Lighting ------------------------------------------------------------------

  private uploadLighting(scene: RenderScene) {
    const { device } = this.core;
    const lights = scene.lights2d ?? [];
    const ambient = [0, 0, 0];
    const lamps: Light2dDraw[] = [];
    for (const l of lights) {
      if (l.kind === "ambient") {
        for (let k = 0; k < 3; k++) {
          ambient[k] += srgbToLinear(l.color[k]) * l.intensity;
        }
      } else lamps.push(l);
    }
    const sorted = lamps.slice(0, MAX_LIGHTS_2D);
    const data = new Float32Array(Math.max(1, sorted.length) * 16);
    sorted.forEach((l, i) => {
      const o = i * 16;
      const kind = l.kind === "sun" ? 3 : l.kind === "spotlight" ? 2 : 1;
      const outer = Math.cos((l.angle * Math.PI) / 360);
      const inner = Math.cos((l.angle * 0.8 * Math.PI) / 360);
      data.set([
        l.position[0],
        l.position[1],
        l.position[2],
        kind,
        srgbToLinear(l.color[0]) * l.intensity,
        srgbToLinear(l.color[1]) * l.intensity,
        srgbToLinear(l.color[2]) * l.intensity,
        l.radius,
        l.direction[0],
        l.direction[1],
        outer,
        inner,
        l.falloff,
        l.shadows ? 1 : 0,
        l.height,
        0,
      ], o);
    });
    device.queue.writeBuffer(this.lightBuffer, 0, data);
    const map = this.items.find((i): i is TileItem =>
      i.kind === "tilemap" && i.occluder
    );
    this.uploadOccluder(map);
    // Cell (0, 0) and cell size of the occluder map, in world units.
    const m = map?.matrix;
    const cellX = m && map ? Math.hypot(m[0], m[1]) / map.width : 1;
    const cellY = m && map ? Math.hypot(m[4], m[5]) / map.height : 1;
    device.queue.writeBuffer(
      this.envBuffer,
      0,
      new Float32Array([
        ambient[0],
        ambient[1],
        ambient[2],
        lights.length ? 1 : 0,
        sorted.length,
        map ? 1 : 0,
        0,
        0,
        m ? m[12] : 0,
        m ? m[13] : 0,
        cellX,
        cellY,
        map?.width ?? 0,
        map?.height ?? 0,
        0,
        0,
      ]),
    );
  }

  private uploadOccluder(map: TileItem | undefined) {
    if (!map) {
      this.occluder?.texture.destroy();
      this.occluder = undefined;
      return;
    }
    const data = new Uint8Array(map.width * map.height);
    for (let i = 0; i < data.length; i++) {
      data[i] = ((map.flags[map.data[i]] ?? 0) & TILE_SOLID) ? 255 : 0;
    }
    let o = this.occluder;
    if (!o || o.width !== map.width || o.height !== map.height) {
      o?.texture.destroy();
      const texture = this.core.device.createTexture({
        label: "occluders2d",
        size: [map.width, map.height],
        format: "r8unorm",
        usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
      });
      o = this.occluder = {
        texture,
        view: texture.createView(),
        width: map.width,
        height: map.height,
        data: new Uint8Array(0),
      };
    }
    if (
      o.data.length === data.length && o.data.every((v, i) => v === data[i])
    ) {
      return;
    }
    o.data = data;
    this.core.device.queue.writeTexture(
      { texture: o.texture },
      data as BufferSource,
      { bytesPerRow: map.width },
      [map.width, map.height],
    );
  }

  // Resources -----------------------------------------------------------------

  private group(key: string, make: () => GPUBindGroup): GPUBindGroup {
    let group = this.groups.get(key);
    if (!group) {
      if (this.groups.size > 512) this.groups.clear();
      group = make();
      this.groups.set(key, group);
    }
    return group;
  }

  private imageGroup(
    albedo: GPUTexture,
    normals: GPUTexture,
    tiles?: GPUTextureView,
    rects?: GPUBuffer,
  ): GPUBindGroup {
    return this.core.device.createBindGroup({
      label: "image2d",
      layout: this.s.image,
      entries: [
        { binding: 0, resource: this.s.nearest },
        { binding: 1, resource: this.s.smooth },
        { binding: 2, resource: albedo.createView() },
        { binding: 3, resource: normals.createView() },
        { binding: 4, resource: tiles ?? this.s.dummyTiles },
        { binding: 5, resource: { buffer: rects ?? this.s.dummyRects } },
      ],
    });
  }

  /** The tile id texture of a map, rewritten when its data changed. */
  private tileTexture(item: TileItem): TileTexture {
    let t = this.tiles.get(item.entity);
    if (!t || t.width !== item.width || t.height !== item.height) {
      t?.texture.destroy();
      const texture = this.core.device.createTexture({
        label: "tiles2d",
        size: [item.width, item.height],
        format: "r16uint",
        usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
      });
      t = {
        texture,
        view: texture.createView(),
        width: item.width,
        height: item.height,
        data: new Uint16Array(0),
        used: 0,
      };
      this.tiles.set(item.entity, t);
    }
    const next = new Uint16Array(item.width * item.height);
    for (let i = 0; i < next.length; i++) next[i] = item.data[i] ?? 0;
    let same = t.data.length === next.length;
    for (let i = 0; same && i < next.length; i++) same = t.data[i] === next[i];
    if (!same) {
      t.data = next;
      this.core.device.queue.writeTexture(
        { texture: t.texture },
        next as BufferSource,
        { bytesPerRow: item.width * 2 },
        [item.width, item.height],
      );
    }
    t.used = this.frame;
    return t;
  }

  private rectBuffer(item: TileItem): GPUBuffer {
    const key = `${item.tileset}:${item.rects.join(",")}`;
    let buffer = this.rects.get(key);
    if (!buffer) {
      if (this.rects.size > 32) {
        for (const b of this.rects.values()) b.destroy();
        this.rects.clear();
        this.groups.clear();
      }
      buffer = this.core.device.createBuffer({
        label: "tile rects",
        size: Math.max(16, item.rects.byteLength),
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      });
      this.core.device.queue.writeBuffer(buffer, 0, item.rects);
      this.rects.set(key, buffer);
    }
    return buffer;
  }

  private sweepTiles(used: Set<number>) {
    for (const [entity, t] of this.tiles) {
      if (!used.has(entity)) {
        t.texture.destroy();
        this.tiles.delete(entity);
      }
    }
  }

  dispose(): void {
    this.quads.destroy();
    this.lightBuffer.destroy();
    this.envBuffer.destroy();
    for (const t of this.tiles.values()) t.texture.destroy();
    for (const b of this.rects.values()) b.destroy();
    this.occluder?.texture.destroy();
    this.tiles.clear();
    this.rects.clear();
    this.groups.clear();
  }
}
