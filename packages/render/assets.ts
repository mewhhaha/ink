/**
 * The asset store: meshes and textures, loaded on demand and uploaded to the
 * GPU. Loading never throws; assets that failed render as a magenta checker
 * so a broken path is visible instead of fatal. Everything is keyed by catalog
 * path (`models/coin.glb`, `textures/brick.png`, `builtin:cube`).
 */
import {
  type Aabb,
  builtinMesh,
  builtinTexture,
  type Image,
  meshBounds,
  type Vec3,
} from "@ink/geometry";
import type { Atlas } from "@ink/schema";
import { AtlasStore } from "./atlas_store.ts";
import { parseGltf } from "./gltf.ts";
import {
  disposeKtx2Workers,
  type Family,
  FORMAT,
  isKtx2,
  readKtx2,
  supportedFamilies,
  type Transcoded,
} from "./ktx2.ts";
import {
  flattenModel,
  type Model,
  modelMeshKey,
  type ModelTexture,
} from "./model.ts";
import {
  BufferUsage,
  srgbToLinear,
  TextureUsage,
  VERTEX_STRIDE,
} from "./gpu.ts";
import { parseObj } from "./obj.ts";
import type { Pipelines } from "./pipelines.ts";
import { TerrainResource } from "./terrain_store.ts";
import { ScatterResource } from "./scatter_store.ts";
import type { AssetStore, RenderMeshData } from "./types.ts";

export interface GpuMesh {
  key: string;
  vertex: GPUBuffer;
  index: GPUBuffer;
  indexCount: number;
  /** Simplified index buffers over `vertex`, finest first (see `lod.ts`). */
  lods?: { index: GPUBuffer; indexCount: number; error: number }[];
  /** Line-list indices of the unique triangle edges, built on first use. */
  edgeIndex?: GPUBuffer;
  edgeCount: number;
  bounds: Aabb;
  morphBounds?: Aabb[];
  data: RenderMeshData;
  lastUsed: number;
}

/** How a texture's bytes are interpreted: `color` is sRGB (base colour),
 * `normal` and `orm` are linear data. The two linear kinds share one upload. */
export type TextureKind = "color" | "normal" | "orm";

export interface GpuTexture {
  /** Unique per upload; material bind groups are keyed by it. */
  id: number;
  texture: GPUTexture;
  size: [number, number];
}

type State = "loading" | "ready" | "failed";
interface MeshEntry {
  state: State;
  mesh?: GpuMesh;
  token: number;
  model?: Model;
  parts?: string[];
  /** A model's merged bind-pose geometry; uploaded only if something draws
   * the model path itself. */
  flat?: RenderMeshData;
  /** Embedded image URIs registered by this model. */
  images?: string[];
}
interface TextureEntry {
  state: State;
  texture?: GpuTexture;
  token: number;
  /** Frame the texture was last asked for (streaming). */
  used?: number;
}

const BRUSH_KEEP = 256;
const BRUSH_IDLE_FRAMES = 240;

function textureBytes(t: GpuTexture): number {
  return Math.round(t.size[0] * t.size[1] * 4 * 1.34);
}

function meshBytes(m: GpuMesh): number {
  return m.data.positions.length / 3 * VERTEX_STRIDE +
    m.indexCount * 4 * (1 + (m.lods ? 0.6 : 0));
}

function averageColor(rgba: Uint8Array | Uint8ClampedArray): Vec3 {
  const color: Vec3 = [0, 0, 0];
  const count = Math.min(4096, rgba.length / 4);
  for (let i = 0; i < count; i++) {
    const at = Math.floor((i + 0.5) * (rgba.length / 4) / count) * 4;
    for (let k = 0; k < 3; k++) color[k] += srgbToLinear(rgba[at + k] / 255);
  }
  return color.map((v) => v / Math.max(1, count)) as Vec3;
}

/** Synthetic URI of image bytes embedded in a model: 64 bits of FNV-1a over
 * the content, so identical images across reloads share one texture. */
function embeddedKey(bytes: Uint8Array, mime: string): string {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193);
    b = Math.imul(b + bytes[i], 0x2545f491) ^ (b >>> 15);
  }
  return `embedded:${(a >>> 0).toString(16)}${
    (b >>> 0).toString(16)
  }-${bytes.length}.${mime.split("/")[1] ?? "bin"}`;
}

export class Assets implements AssetStore {
  version = 0;
  base: string;
  private meshes = new Map<string, MeshEntry>();
  private textures = new Map<string, TextureEntry>();
  private listeners = new Set<() => void>();
  private sampler: GPUSampler;
  private samplers = new Map<string, GPUSampler>();
  private ownedTextures = new Set<GPUTexture>();
  /** Raw RGBA8 sources (`setTexture`, builtin generators), so a texture used
   * both as colour and as data can be uploaded in both formats. */
  private raw = new Map<string, Image>();
  private averageColors = new Map<string, Vec3>();
  private materials = new Map<string, GPUBindGroup>();
  /** Image bytes embedded in glTF files, by synthetic URI, until loaded. */
  private embedded = new Map<string, { bytes: Uint8Array; mime: string }>();
  private families: Family[];
  private nextTextureId = 1;
  readonly white: GpuTexture;
  readonly placeholder: GpuTexture;
  /** Linear defaults: a flat normal map and an all-ones ORM map. */
  readonly flatNormal: GpuTexture;
  readonly whiteLinear: GpuTexture;
  /** Bind group of the default material (white, flat normal, white ORM). */
  readonly defaultMaterial: GPUBindGroup;
  private disposed = false;
  /** Atlas files for sprites and tile maps. */
  readonly atlases = new AtlasStore(
    (path, bust) => this.url(path, bust),
    () => this.changed(),
    (work) => this.track(work),
  );

  constructor(
    private device: GPUDevice,
    private pipelines: Pipelines,
    base: string,
    /** Catalog path -> stored path, for builds that ship imported files. */
    private map: Record<string, string> = {},
  ) {
    this.base = base;
    this.families = supportedFamilies(device);
    this.sampler = device.createSampler({
      label: "material",
      addressModeU: "repeat",
      addressModeV: "repeat",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      maxAnisotropy: 8,
    });
    this.white = this.fromPixels(
      "white",
      1,
      1,
      new Uint8Array([255, 255, 255, 255]),
    );
    this.whiteLinear = this.fromPixels(
      "white-linear",
      1,
      1,
      new Uint8Array([255, 255, 255, 255]),
      true,
    );
    this.flatNormal = this.fromPixels(
      "flat-normal",
      1,
      1,
      new Uint8Array([128, 128, 255, 255]),
      true,
    );
    this.defaultMaterial = this.material(
      this.white,
      this.flatNormal,
      this.whiteLinear,
    );
    const checker = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const on = ((x >> 3) + (y >> 3)) % 2 === 0;
        checker.set(
          on ? [255, 0, 255, 255] : [32, 0, 32, 255],
          (y * 64 + x) * 4,
        );
      }
    }
    this.placeholder = this.fromPixels("placeholder", 64, 64, checker);
    this.register("builtin:cube", builtinMesh("builtin:cube")!);
  }

  // Public store API ----------------------------------------------------------

  preload(kind: "mesh" | "texture", path: string): void {
    if (kind === "mesh") this.ensureMesh(path);
    else this.ensureTexture(path, false);
  }

  atlas(path: string): Atlas | undefined {
    return this.atlases.get(path);
  }

  private terrains = new Map<string, TerrainResource>();
  private scatters = new Map<string, ScatterResource>();

  /** The terrain data of a `*.terrain` asset; starts loading on first use. */
  terrain(path: string): TerrainResource {
    let resource = this.terrains.get(path);
    if (!resource) {
      resource = new TerrainResource(path);
      this.terrains.set(path, resource);
      resource.onState(() => this.changed());
      void this.track(resource.load(this.url(path, false)));
    }
    return resource;
  }

  /** Register terrain data without fetching (headless runs, tests, scripts). */
  setTerrain(path: string, resource: TerrainResource): void {
    this.terrains.get(path)?.dispose();
    this.terrains.set(path, resource);
    resource.onState(() => this.changed());
    this.changed();
  }

  /** The placements of a `*.scatter` asset; starts loading on first use. */
  scatter(path: string): ScatterResource {
    let resource = this.scatters.get(path);
    if (!resource) {
      resource = new ScatterResource(path);
      this.scatters.set(path, resource);
      resource.onState(() => this.changed());
      void this.track(resource.load(this.url(path, false)));
    }
    return resource;
  }

  setScatter(path: string, resource: ScatterResource): void {
    this.scatters.get(path)?.dispose();
    this.scatters.set(path, resource);
    resource.onState(() => this.changed());
    this.changed();
  }

  /** Every terrain and scatter resource in use. */
  worldResources() {
    return { terrains: this.terrains, scatters: this.scatters };
  }

  reload(path: string): void {
    if (path.startsWith("builtin:")) return;
    this.atlases.reload(path);
    const terrain = this.terrains.get(path);
    if (terrain) void this.track(terrain.load(this.url(path, true)));
    const scatter = this.scatters.get(path);
    if (scatter) void this.track(scatter.load(this.url(path, true)));
    const url = this.url(path, false);
    for (const [key, entry] of this.meshes) {
      if (key === path || entry.model?.dependencies.includes(url)) {
        this.loadMesh(key, true);
      }
    }
    // Imported glTF maps are absolute URLs; catalog change events are relative.
    for (const key of this.textures.keys()) {
      const linear = key.endsWith("|linear"),
        source = linear ? key.slice(0, -7) : key;
      if (this.url(source, false) === url) {
        this.loadTexture(source, linear, true);
      }
    }
  }

  setMesh(key: string, data: RenderMeshData): void {
    this.register(key, data);
    this.changed();
  }

  setTexture(
    path: string,
    image: { width: number; height: number; data: Uint8Array },
  ): void {
    this.raw.set(path, image);
    const keys = [path];
    if (this.textures.has(`${path}|linear`)) keys.push(`${path}|linear`);
    for (const key of keys) {
      const texture = this.fromPixels(
        path,
        image.width,
        image.height,
        image.data,
        key !== path,
      );
      const entry = this.textures.get(key);
      if (entry) {
        this.releaseTexture(entry.texture);
        entry.texture = texture;
        entry.state = "ready";
        entry.token++;
      } else this.textures.set(key, { state: "ready", texture, token: 0 });
    }
    this.changed();
  }

  /** Resolves once every load started so far has finished or failed,
   * including loads started while waiting. */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private pending = new Set<Promise<void>>();
  private track(p: Promise<void>): Promise<void> {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
    return p;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  textureSize(path: string): [number, number] | undefined {
    return (this.textures.get(path) ?? this.textures.get(`${path}|linear`))
      ?.texture?.size;
  }

  textureColor(path: string): Vec3 | undefined {
    return this.averageColors.get(path);
  }

  meshData(path: string): RenderMeshData | undefined {
    const entry = this.ensureMesh(path);
    return entry.state === "ready" ? entry.mesh?.data ?? entry.flat : undefined;
  }

  modelData(path: string): Model | undefined {
    return this.ensureMesh(path).model;
  }

  // Renderer API --------------------------------------------------------------

  /** The GPU mesh for a path: `undefined` while it loads, the placeholder cube
   * if it failed. */
  getMesh(path: string, frame: number): GpuMesh | undefined {
    const entry = this.ensureMesh(path);
    if (entry.state === "loading") return undefined;
    if (entry.state === "ready" && !entry.mesh && entry.flat) {
      entry.mesh = this.upload(path, entry.flat);
    }
    const mesh = entry.state === "ready"
      ? entry.mesh!
      : this.meshes.get("builtin:cube")!.mesh!;
    mesh.lastUsed = frame;
    return mesh;
  }

  /** Whether loading the mesh failed (it then draws as the placeholder). */
  meshFailed(path: string): boolean {
    return this.meshes.get(path)?.state === "failed";
  }

  /** Whether the mesh is registered (brush parts are registered once). */
  hasMesh(key: string): boolean {
    return this.meshes.get(key)?.state === "ready";
  }

  /** The texture to sample for a path. `color` is uploaded as sRGB, `normal`
   * and `orm` as linear data. Without a path, while loading, or (for data
   * maps) after a failure, the neutral default of the kind; a failed colour
   * texture is the magenta checker. */
  getTexture(
    path: string | undefined,
    kind: TextureKind = "color",
  ): GpuTexture {
    const neutral = kind === "color"
      ? this.white
      : kind === "normal"
      ? this.flatNormal
      : this.whiteLinear;
    if (!path) return neutral;
    const entry = this.ensureTexture(path, kind !== "color");
    entry.used = this.clock;
    if (entry.state === "ready") return entry.texture!;
    return entry.state === "failed" && kind === "color"
      ? this.placeholder
      : neutral;
  }

  /** Bind group for a material's three textures, cached by upload. */
  material(
    base: GpuTexture,
    normal: GpuTexture,
    orm: GpuTexture,
    extra: {
      occlusion?: GpuTexture;
      emission?: GpuTexture;
      samplers?: (ModelTexture["sampler"] | undefined)[];
    } = {},
  ): GPUBindGroup {
    const occlusion = extra.occlusion ?? this.whiteLinear;
    const emission = extra.emission ?? this.white;
    const settings = extra.samplers ?? [];
    const key =
      `${base.id}:${normal.id}:${orm.id}:${occlusion.id}:${emission.id}:${
        JSON.stringify(settings)
      }`;
    let group = this.materials.get(key);
    if (!group) {
      if (this.materials.size > 1024) this.materials.clear();
      group = this.device.createBindGroup({
        label: "material",
        layout: this.pipelines.materialLayout,
        entries: [
          { binding: 0, resource: this.samplerFor(settings[0]) },
          { binding: 1, resource: base.texture.createView() },
          { binding: 2, resource: normal.texture.createView() },
          { binding: 3, resource: orm.texture.createView() },
          { binding: 4, resource: occlusion.texture.createView() },
          { binding: 5, resource: emission.texture.createView() },
          { binding: 6, resource: this.samplerFor(settings[1]) },
          { binding: 7, resource: this.samplerFor(settings[2]) },
          { binding: 8, resource: this.samplerFor(settings[3]) },
          { binding: 9, resource: this.samplerFor(settings[4]) },
        ],
      });
      this.materials.set(key, group);
    }
    return group;
  }

  private samplerFor(settings?: ModelTexture["sampler"]): GPUSampler {
    if (!settings) return this.sampler;
    const key = JSON.stringify(settings);
    let sampler = this.samplers.get(key);
    if (!sampler) {
      const wrap = (value: number | undefined): GPUAddressMode =>
        value === 33071
          ? "clamp-to-edge"
          : value === 33648
          ? "mirror-repeat"
          : "repeat";
      const filter = settings.minFilter ?? 9987;
      sampler = this.device.createSampler({
        addressModeU: wrap(settings.wrapS),
        addressModeV: wrap(settings.wrapT),
        magFilter: settings.magFilter === 9728 ? "nearest" : "linear",
        minFilter: [9728, 9984, 9986].includes(filter) ? "nearest" : "linear",
        mipmapFilter: [9984, 9985].includes(filter) ? "nearest" : "linear",
        lodMaxClamp: filter === 9728 || filter === 9729 ? 0 : 32,
      });
      this.samplers.set(key, sampler);
    }
    return sampler;
  }

  /** Frame counter of the last `endFrame`, for ageing. */
  private clock = 0;
  /**
   * Memory the store keeps resident for meshes and textures, in bytes
   * (estimated from sizes; compressed textures count as RGBA8). When the
   * total exceeds it, the least recently used meshes and textures that can be
   * reloaded from their files are released and stream back in when drawn
   * again. Default 1 GiB.
   */
  memoryBudget = 1024 * 1024 * 1024;
  /** Bytes released by the budget so far, for tests and tools. */
  evictedBytes = 0;

  /** Estimated resident bytes of meshes and textures. */
  residentBytes(): number {
    let total = 0;
    for (const entry of this.textures.values()) {
      if (entry.texture) total += textureBytes(entry.texture);
    }
    for (const entry of this.meshes.values()) {
      if (entry.mesh) total += meshBytes(entry.mesh);
    }
    return total;
  }

  private evict(frame: number) {
    let total = this.residentBytes();
    if (total <= this.memoryBudget) return;
    const idle = 30;
    const candidates: { used: number; bytes: number; free: () => void }[] = [];
    for (const [key, entry] of this.textures) {
      const path = key.endsWith("|linear") ? key.slice(0, -7) : key;
      if (
        !entry.texture || entry.state !== "ready" || this.raw.has(path) ||
        path.startsWith("builtin:") || path.startsWith("embedded:") ||
        entry.texture === this.white as unknown ||
        frame - (entry.used ?? 0) < idle
      ) continue;
      candidates.push({
        used: entry.used ?? 0,
        bytes: textureBytes(entry.texture),
        free: () => {
          this.releaseTexture(entry.texture);
          this.textures.delete(key);
          this.materials.clear();
        },
      });
    }
    for (const [key, entry] of this.meshes) {
      if (
        !entry.mesh || entry.state !== "ready" || key.startsWith("builtin:") ||
        key.startsWith("brush:") || entry.model || entry.parts ||
        frame - entry.mesh.lastUsed < idle
      ) continue;
      candidates.push({
        used: entry.mesh.lastUsed,
        bytes: meshBytes(entry.mesh),
        free: () => {
          this.destroyMesh(entry.mesh!);
          this.meshes.delete(key);
        },
      });
    }
    candidates.sort((a, b) => a.used - b.used);
    for (const c of candidates) {
      if (total <= this.memoryBudget) break;
      c.free();
      total -= c.bytes;
      this.evictedBytes += c.bytes;
    }
  }

  /** Free brush meshes that have not been drawn for a while, and keep the
   * resident meshes and textures within `memoryBudget`. */
  endFrame(frame: number): void {
    this.clock = frame;
    this.evict(frame);
    let brushes = 0;
    for (const key of this.meshes.keys()) {
      if (key.startsWith("brush:")) brushes++;
    }
    if (brushes <= BRUSH_KEEP) return;
    for (const [key, entry] of this.meshes) {
      if (
        key.startsWith("brush:") && entry.mesh &&
        frame - entry.mesh.lastUsed > BRUSH_IDLE_FRAMES
      ) {
        entry.mesh.vertex.destroy();
        entry.mesh.index.destroy();
        entry.mesh.edgeIndex?.destroy();
        this.meshes.delete(key);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    disposeKtx2Workers();
    this.embedded.clear();
    this.listeners.clear();
    for (const e of this.meshes.values()) if (e.mesh) this.destroyMesh(e.mesh);
    for (const texture of this.ownedTextures) texture.destroy();
    this.meshes.clear();
    this.textures.clear();
    this.ownedTextures.clear();
    this.materials.clear();
    this.samplers.clear();
    this.raw.clear();
    this.averageColors.clear();
  }

  private destroyMesh(mesh: GpuMesh) {
    mesh.vertex.destroy();
    mesh.index.destroy();
    mesh.edgeIndex?.destroy();
    for (const lod of mesh.lods ?? []) lod.index.destroy();
  }

  /** Index buffer drawing the unique edges of a mesh's triangles. */
  edges(mesh: GpuMesh): GPUBuffer {
    if (mesh.edgeIndex) return mesh.edgeIndex;
    const seen = new Set<number>();
    const out: number[] = [];
    const idx = mesh.data.indices;
    const pos = mesh.data.positions;
    // Merge coincident vertices so flat faces on shared positions dedupe.
    const canon = new Map<string, number>();
    const rep = (i: number) => {
      const key = `${pos[i * 3].toFixed(4)},${pos[i * 3 + 1].toFixed(4)},${
        pos[i * 3 + 2].toFixed(4)
      }`;
      let r = canon.get(key);
      if (r === undefined) canon.set(key, r = i);
      return r;
    };
    for (let t = 0; t + 2 < idx.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = idx[t + k], b = idx[t + (k + 1) % 3];
        const ra = rep(a), rb = rep(b);
        if (ra === rb) continue;
        const lo = Math.min(ra, rb), hi = Math.max(ra, rb);
        const id = lo * 4294967296 + hi;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(a, b);
      }
    }
    const data = new Uint32Array(out);
    const buffer = this.device.createBuffer({
      label: `${mesh.key}:edges`,
      size: Math.max(16, data.byteLength),
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, data);
    mesh.edgeIndex = buffer;
    mesh.edgeCount = data.length;
    return buffer;
  }

  // Meshes --------------------------------------------------------------------

  private ensureMesh(path: string): MeshEntry {
    let entry = this.meshes.get(path);
    if (!entry) {
      const builtin = builtinMesh(path);
      if (builtin) {
        this.register(path, builtin);
        return this.meshes.get(path)!;
      }
      entry = { state: "loading", token: 0 };
      this.meshes.set(path, entry);
      if (!path.startsWith("brush:")) this.loadMesh(path, false);
    }
    return entry;
  }

  /** Register geometry under a key without notifying listeners. */
  register(key: string, data: RenderMeshData): void {
    const mesh = this.upload(key, data);
    const entry = this.meshes.get(key);
    if (entry) {
      if (entry.mesh) this.destroyMesh(entry.mesh);
      entry.mesh = mesh;
      entry.state = "ready";
      entry.token++;
    } else this.meshes.set(key, { state: "ready", mesh, token: 0 });
  }

  private upload(key: string, data: RenderMeshData): GpuMesh {
    const count = data.positions.length / 3;
    const floats = new Float32Array(count * (VERTEX_STRIDE / 4));
    const ints = new Uint32Array(floats.buffer);
    const stride = VERTEX_STRIDE / 4;
    for (let i = 0; i < count; i++) {
      const o = i * stride;
      floats[o] = data.positions[i * 3];
      floats[o + 1] = data.positions[i * 3 + 1];
      floats[o + 2] = data.positions[i * 3 + 2];
      floats[o + 3] = data.normals[i * 3];
      floats[o + 4] = data.normals[i * 3 + 1];
      floats[o + 5] = data.normals[i * 3 + 2];
      floats[o + 6] = data.uvs[i * 2] ?? 0;
      floats[o + 7] = data.uvs[i * 2 + 1] ?? 0;
      if (data.colors) {
        floats[o + 8] = srgbToLinear(data.colors[i * 4]);
        floats[o + 9] = srgbToLinear(data.colors[i * 4 + 1]);
        floats[o + 10] = srgbToLinear(data.colors[i * 4 + 2]);
        floats[o + 11] = data.colors[i * 4 + 3];
      } else {
        floats[o + 8] =
          floats[o + 9] =
          floats[o + 10] =
          floats[o + 11] =
            1;
      }
      ints[o + 12] = data.faces ? data.faces[i] : 0xffffffff;
      for (let j = 0; j < 4; j++) {
        ints[o + 13 + j] = data.joints?.[i * 4 + j] ?? 0;
        floats[o + 17 + j] = data.weights?.[i * 4 + j] ?? (j === 0 ? 1 : 0);
        ints[o + 23 + j] = data.joints1?.[i * 4 + j] ?? 0;
        floats[o + 27 + j] = data.weights1?.[i * 4 + j] ?? 0;
      }
      floats[o + 21] = data.uvs1?.[i * 2] ?? floats[o + 6];
      floats[o + 22] = data.uvs1?.[i * 2 + 1] ?? floats[o + 7];
    }
    const vertex = this.device.createBuffer({
      label: `${key}:vertices`,
      size: Math.max(16, floats.byteLength),
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vertex, 0, floats);
    const index = this.device.createBuffer({
      label: `${key}:indices`,
      size: Math.max(16, data.indices.byteLength),
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(index, 0, data.indices);
    const lods = data.lods?.map((level, i) => {
      const buffer = this.device.createBuffer({
        label: `${key}:lod${i + 1}`,
        size: Math.max(16, level.indices.byteLength),
        usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(buffer, 0, level.indices);
      return {
        index: buffer,
        indexCount: level.indices.length,
        error: level.error,
      };
    });
    return {
      key,
      vertex,
      index,
      indexCount: data.indices.length,
      lods,
      edgeCount: 0,
      bounds: meshBounds(data),
      morphBounds: data.targets?.map((t) =>
        t.positions
          ? meshBounds({ positions: t.positions })
          : { min: [0, 0, 0], max: [0, 0, 0] }
      ),
      data,
      lastUsed: 0,
    };
  }

  private url(path: string, bust: boolean): string {
    const root = new URL(
      this.base.endsWith("/") ? this.base : `${this.base}/`,
      globalThis.location?.href ?? "file:///",
    );
    const url = new URL(this.map[path] ?? path, root);
    if (bust) url.searchParams.set("v", String(Date.now()));
    return url.href;
  }

  private loadMesh(path: string, bust: boolean): Promise<void> {
    return this.track(this.loadMeshNow(path, bust));
  }

  private async loadMeshNow(path: string, bust: boolean): Promise<void> {
    let entry = this.meshes.get(path);
    if (!entry) this.meshes.set(path, entry = { state: "loading", token: 0 });
    const token = ++entry.token;
    try {
      const url = this.url(path, bust);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const lower = path.toLowerCase();
      let data: RenderMeshData;
      let model: Model | undefined;
      const images: string[] = [];
      if (lower.endsWith(".glb") || lower.endsWith(".gltf")) {
        model = await parseGltf(
          await res.arrayBuffer(),
          url,
          (bytes, mime) => {
            const key = embeddedKey(bytes, mime);
            this.embedded.set(key, { bytes, mime });
            images.push(key);
            return key;
          },
        );
        data = flattenModel(model);
      } else if (lower.endsWith(".obj")) {
        data = parseObj(await res.text());
      } else throw new Error("unsupported mesh format");
      if (this.disposed || entry.token !== token) return;
      for (const key of entry.parts ?? []) {
        const old = this.meshes.get(key)?.mesh;
        if (old) this.destroyMesh(old);
        this.meshes.delete(key);
      }
      entry.parts = [];
      model?.meshes.forEach((mesh, i) =>
        mesh.forEach((p, j) => {
          const key = modelMeshKey(path, i, j);
          this.register(key, p.mesh);
          entry!.parts!.push(key);
        })
      );
      this.dropImages(entry.images, images);
      entry.images = images;
      entry.model = model;
      if (entry.mesh) this.destroyMesh(entry.mesh);
      entry.mesh = undefined;
      entry.flat = undefined;
      // A model's merged geometry is only uploaded if its path is drawn
      // directly; draws expand to the per-primitive meshes above.
      if (model) entry.flat = data;
      else entry.mesh = this.upload(path, data);
      entry.state = "ready";
    } catch (error) {
      if (this.disposed || entry.token !== token) return;
      if (entry.state !== "ready") entry.state = "failed";
      console.warn(`ink: could not load mesh "${path}": ${error}`);
    }
    this.changed();
  }

  // Textures ------------------------------------------------------------------

  /** Pixels of a texture known without fetching: set by the host or a
   * `builtin:` generator. */
  private pixelsOf(path: string): Image | undefined {
    let image = this.raw.get(path);
    if (!image && path.startsWith("builtin:")) {
      image = builtinTexture(path);
      if (image) this.raw.set(path, image);
    }
    return image;
  }

  private ensureTexture(path: string, linear: boolean): TextureEntry {
    const key = linear ? `${path}|linear` : path;
    let entry = this.textures.get(key);
    if (!entry) {
      const image = this.pixelsOf(path);
      if (image) {
        const texture = this.fromPixels(
          path,
          image.width,
          image.height,
          image.data,
          linear,
        );
        entry = { state: "ready", texture, token: 0 };
        this.textures.set(key, entry);
      } else if (path.startsWith("builtin:")) {
        entry = { state: "failed", token: 0 };
        this.textures.set(key, entry);
        console.warn(`ink: unknown builtin texture "${path}"`);
      } else {
        entry = { state: "loading", token: 0 };
        this.textures.set(key, entry);
        this.loadTexture(path, linear, false);
      }
    }
    return entry;
  }

  private loadTexture(
    path: string,
    linear: boolean,
    bust: boolean,
  ): Promise<void> {
    return this.track(this.loadTextureNow(path, linear, bust));
  }

  private async loadTextureNow(
    path: string,
    linear: boolean,
    bust: boolean,
  ): Promise<void> {
    const key = linear ? `${path}|linear` : path;
    let entry = this.textures.get(key);
    if (!entry) this.textures.set(key, entry = { state: "loading", token: 0 });
    const token = ++entry.token;
    try {
      let blob: Blob;
      const embedded = this.embedded.get(path);
      if (embedded) {
        blob = new Blob([embedded.bytes as BlobPart], { type: embedded.mime });
      } else {
        const res = await fetch(this.url(path, bust));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        blob = await res.blob();
      }
      const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
      if (isKtx2(head)) {
        const ktx = await readKtx2(
          new Uint8Array(await blob.arrayBuffer()),
          this.families,
        );
        if (this.disposed || entry.token !== token) return;
        const texture = this.fromKtx2(path, ktx, linear);
        this.releaseTexture(entry.texture);
        entry.texture = texture;
        entry.state = "ready";
      } else {
        const bitmap = await createImageBitmap(blob, {
          colorSpaceConversion: "none",
          premultiplyAlpha: "none",
        });
        try {
          if (this.disposed || entry.token !== token) return;
          const texture = this.fromBitmap(path, bitmap, linear);
          this.releaseTexture(entry.texture);
          entry.texture = texture;
          entry.state = "ready";
        } finally {
          bitmap.close();
        }
      }
      // Both colour spaces of an embedded image may still be wanted; keep the
      // bytes until its model is replaced.
    } catch (error) {
      if (this.disposed || entry.token !== token) return;
      if (entry.state !== "ready") entry.state = "failed";
      console.warn(`ink: could not load texture "${path}": ${error}`);
    }
    this.changed();
  }

  private bindTexture(texture: GPUTexture, size: [number, number]): GpuTexture {
    return { id: this.nextTextureId++, texture, size };
  }

  private releaseTexture(value?: GpuTexture) {
    if (!value) return;
    value.texture.destroy();
    this.ownedTextures.delete(value.texture);
  }

  private createTexture(
    label: string,
    w: number,
    h: number,
    linear: boolean,
  ): GPUTexture {
    const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
    const texture = this.device.createTexture({
      label,
      size: [w, h],
      format: linear ? "rgba8unorm" : "rgba8unorm-srgb",
      mipLevelCount: levels,
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST |
        TextureUsage.RENDER_ATTACHMENT,
    });
    this.ownedTextures.add(texture);
    return texture;
  }

  private fromBitmap(
    label: string,
    bitmap: ImageBitmap,
    linear: boolean,
  ): GpuTexture {
    if (!linear && typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(64, 64);
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bitmap, 0, 0, 64, 64);
      this.averageColors.set(
        label,
        averageColor(ctx.getImageData(0, 0, 64, 64).data),
      );
    }
    if (typeof this.device.queue.copyExternalImageToTexture !== "function") {
      throw new Error(
        "this runtime cannot upload images; use assets.setTexture with raw pixels",
      );
    }
    const texture = this.createTexture(
      label,
      bitmap.width,
      bitmap.height,
      linear,
    );
    this.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture },
      [bitmap.width, bitmap.height],
    );
    this.generateMips(texture);
    return this.bindTexture(texture, [bitmap.width, bitmap.height]);
  }

  /** Upload a transcoded KTX2 file: block formats as they are, RGBA8 with
   * the importer's mips (or generated ones if the file has a single level). */
  private fromKtx2(
    label: string,
    ktx: Transcoded,
    linear: boolean,
  ): GpuTexture {
    const family = ktx.family;
    const format = FORMAT[family][linear ? "linear" : "srgb"];
    const block = family === "rgba8" ? 1 : 4;
    const complete = Math.floor(Math.log2(Math.max(ktx.width, ktx.height))) + 1;
    const generate = family === "rgba8" && ktx.levels.length < complete;
    const texture = this.device.createTexture({
      label,
      size: [ktx.width, ktx.height],
      format,
      mipLevelCount: generate ? complete : ktx.levels.length,
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST |
        (family === "rgba8" ? TextureUsage.RENDER_ATTACHMENT : 0),
    });
    this.ownedTextures.add(texture);
    ktx.levels.forEach((level, mipLevel) => {
      const w = Math.ceil(level.width / block) * block;
      const h = Math.ceil(level.height / block) * block;
      const bytesPerRow = family === "rgba8" ? w * 4 : (w / 4) * 16;
      this.device.queue.writeTexture(
        { texture, mipLevel },
        level.data as BufferSource,
        { bytesPerRow, rowsPerImage: family === "rgba8" ? h : h / 4 },
        [w, h],
      );
    });
    if (generate) this.generateMips(texture);
    if (!linear) this.averageColors.set(label, ktx.average);
    return this.bindTexture(texture, [ktx.width, ktx.height]);
  }

  /** Forget embedded images (bytes and textures) a model no longer uses. */
  private dropImages(old: string[] | undefined, next: string[]) {
    for (const key of old ?? []) {
      if (next.includes(key)) continue;
      this.embedded.delete(key);
      let shared = false;
      for (const other of this.meshes.values()) {
        if (other.images?.includes(key) && !old?.includes(key)) shared = true;
      }
      if (shared) continue;
      for (const textureKey of [key, `${key}|linear`]) {
        const entry = this.textures.get(textureKey);
        if (!entry) continue;
        this.releaseTexture(entry.texture);
        this.textures.delete(textureKey);
        this.averageColors.delete(textureKey);
      }
    }
  }

  private fromPixels(
    label: string,
    w: number,
    h: number,
    rgba: Uint8Array,
    linear = false,
  ): GpuTexture {
    if (!linear) this.averageColors.set(label, averageColor(rgba));
    const texture = this.createTexture(label, w, h, linear);
    this.device.queue.writeTexture(
      { texture },
      rgba as BufferSource,
      { bytesPerRow: w * 4 },
      [w, h],
    );
    this.generateMips(texture);
    return this.bindTexture(texture, [w, h]);
  }

  private generateMips(texture: GPUTexture): void {
    if (texture.mipLevelCount <= 1) return;
    const pipeline = this.pipelines.mip(texture.format);
    const sampler = this.device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
    });
    const encoder = this.device.createCommandEncoder({ label: "mipmaps" });
    for (let level = 1; level < texture.mipLevelCount; level++) {
      const src = texture.createView({
        baseMipLevel: level - 1,
        mipLevelCount: 1,
      });
      const dst = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: dst, loadOp: "clear", storeOp: "store" }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: this.pipelines.mipLayout,
          entries: [
            { binding: 0, resource: src },
            { binding: 1, resource: sampler },
          ],
        }),
      );
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  private changed(): void {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }
}
