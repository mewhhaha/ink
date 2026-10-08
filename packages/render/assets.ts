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
} from "@ink/geometry";
import { parseGltf } from "./gltf.ts";
import {
  BufferUsage,
  srgbToLinear,
  TextureUsage,
  VERTEX_STRIDE,
} from "./gpu.ts";
import { parseObj } from "./obj.ts";
import type { Pipelines } from "./pipelines.ts";
import type { AssetStore, RenderMeshData } from "./types.ts";

export interface GpuMesh {
  key: string;
  vertex: GPUBuffer;
  index: GPUBuffer;
  indexCount: number;
  /** Line-list indices of the unique triangle edges, built on first use. */
  edgeIndex?: GPUBuffer;
  edgeCount: number;
  bounds: Aabb;
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
}
interface TextureEntry {
  state: State;
  texture?: GpuTexture;
  token: number;
}

const BRUSH_KEEP = 256;
const BRUSH_IDLE_FRAMES = 240;

export class Assets implements AssetStore {
  base: string;
  private meshes = new Map<string, MeshEntry>();
  private textures = new Map<string, TextureEntry>();
  private listeners = new Set<() => void>();
  private sampler: GPUSampler;
  /** Raw RGBA8 sources (`setTexture`, builtin generators), so a texture used
   * both as colour and as data can be uploaded in both formats. */
  private raw = new Map<string, Image>();
  private materials = new Map<string, GPUBindGroup>();
  private nextTextureId = 1;
  readonly white: GpuTexture;
  readonly placeholder: GpuTexture;
  /** Linear defaults: a flat normal map and an all-ones ORM map. */
  readonly flatNormal: GpuTexture;
  readonly whiteLinear: GpuTexture;
  /** Bind group of the default material (white, flat normal, white ORM). */
  readonly defaultMaterial: GPUBindGroup;
  private disposed = false;

  constructor(
    private device: GPUDevice,
    private pipelines: Pipelines,
    base: string,
  ) {
    this.base = base;
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

  reload(path: string): void {
    if (path.startsWith("builtin:")) return;
    if (this.meshes.has(path)) this.loadMesh(path, true);
    if (this.textures.has(path)) this.loadTexture(path, false, true);
    if (this.textures.has(`${path}|linear`)) this.loadTexture(path, true, true);
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

  // Renderer API --------------------------------------------------------------

  /** The GPU mesh for a path: `undefined` while it loads, the placeholder cube
   * if it failed. */
  getMesh(path: string, frame: number): GpuMesh | undefined {
    const entry = this.ensureMesh(path);
    if (entry.state === "loading") return undefined;
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
  ): GPUBindGroup {
    const key = `${base.id}:${normal.id}:${orm.id}`;
    let group = this.materials.get(key);
    if (!group) {
      if (this.materials.size > 1024) this.materials.clear();
      group = this.device.createBindGroup({
        label: "material",
        layout: this.pipelines.materialLayout,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: base.texture.createView() },
          { binding: 2, resource: normal.texture.createView() },
          { binding: 3, resource: orm.texture.createView() },
        ],
      });
      this.materials.set(key, group);
    }
    return group;
  }

  /** Free brush meshes that have not been drawn for a while. */
  endFrame(frame: number): void {
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
    this.listeners.clear();
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
    return {
      key,
      vertex,
      index,
      indexCount: data.indices.length,
      edgeCount: 0,
      bounds: meshBounds(data),
      data,
      lastUsed: 0,
    };
  }

  private url(path: string, bust: boolean): string {
    const root = new URL(
      this.base.endsWith("/") ? this.base : `${this.base}/`,
      globalThis.location?.href ?? "file:///",
    );
    const url = new URL(path, root);
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
      if (lower.endsWith(".glb") || lower.endsWith(".gltf")) {
        data = await parseGltf(await res.arrayBuffer(), url);
      } else if (lower.endsWith(".obj")) {
        data = parseObj(await res.text());
      } else throw new Error("unsupported mesh format");
      if (this.disposed || entry.token !== token) return;
      entry.mesh = this.upload(path, data);
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
      const res = await fetch(this.url(path, bust));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bitmap = await createImageBitmap(await res.blob(), {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
      });
      if (this.disposed || entry.token !== token) return;
      entry.texture = this.fromBitmap(path, bitmap, linear);
      entry.state = "ready";
      bitmap.close();
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

  private createTexture(
    label: string,
    w: number,
    h: number,
    linear: boolean,
  ): GPUTexture {
    const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
    return this.device.createTexture({
      label,
      size: [w, h],
      format: linear ? "rgba8unorm" : "rgba8unorm-srgb",
      mipLevelCount: levels,
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST |
        TextureUsage.RENDER_ATTACHMENT,
    });
  }

  private fromBitmap(
    label: string,
    bitmap: ImageBitmap,
    linear: boolean,
  ): GpuTexture {
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

  private fromPixels(
    label: string,
    w: number,
    h: number,
    rgba: Uint8Array,
    linear = false,
  ): GpuTexture {
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
    for (const listener of [...this.listeners]) listener();
  }
}
