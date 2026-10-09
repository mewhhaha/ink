/**
 * Scatter layers on the GPU: chunk residency, the culling compute pass, the
 * depth pyramid and the indirect draws. See shaders/scatter.ts for what one
 * thread does.
 *
 * Placements live on the CPU in 128 m chunks (`ChunkIndex`). A layer keeps on
 * the GPU only the chunks near the camera (streamed in and out as it moves,
 * with hysteresis); the culling dispatch covers just those.
 */
import { type Mat4, mat4, type Placement, SCATTER_CHUNK } from "@ink/geometry";
import type { Core } from "./core.ts";
import { BufferUsage, GrowBuffer, ShaderStage, TextureUsage } from "./gpu.ts";
import type { GpuMesh } from "./assets.ts";
import { lodGeometry } from "./lod.ts";
import {
  CULL_PARAM_FLOATS,
  CULL_WORKGROUP,
  hizDownShader,
  hizShader,
  INSTANCE_WORDS,
  MAX_LEVELS,
  MAX_LISTS,
  scatterCullShader,
} from "./shaders/scatter.ts";
import { kitOf as terrainKit } from "./terrain_pipelines.ts";
import type { ScatterResource } from "./scatter_store.ts";
import type { Camera, ScatterDraw } from "./types.ts";
import type { TerrainGpu } from "./terrain_gpu.ts";

const FLOATS = 6;
/** Instances stored per list and level (a multiple of 8, so ranges are
 * 256-byte aligned as storage bindings need). */
export const MAIN_CAPACITY = 8192;
export const SHADOW_CAPACITY = 4096;
/** Chunks leave the GPU this much beyond the distance they enter at. */
const HYSTERESIS = 96;
/** Most placements a layer keeps resident. */
export const RESIDENT_BUDGET = 400_000;

// Chunks ---------------------------------------------------------------------------

interface Chunk {
  cx: number;
  cz: number;
  data: Float32Array;
  count: number;
}

const keyOf = (cx: number, cz: number) => cx * 65536 + cz;
const chunkOf = (v: number) => Math.floor(v / SCATTER_CHUNK);

/** The placements of a resource bucketed by chunk, kept in step with it. */
export class ChunkIndex {
  chunks = new Map<number, Chunk>();
  private set?: unknown;
  private pending: {
    added: Placement[];
    removed: Placement[];
    reload: boolean;
  }[] = [];
  private off: () => void;
  version = 0;
  count = 0;

  constructor(private resource: ScatterResource) {
    this.off = resource.onChange((c) => {
      this.pending.push({
        added: c.added,
        removed: c.removed,
        reload: c.cause === "load",
      });
    });
  }

  /** Apply what changed in the resource since the last call. */
  sync() {
    const set = this.resource.set;
    if (!set) return;
    if (this.set !== set) {
      this.rebuild();
      return;
    }
    for (const change of this.pending) {
      if (change.reload) return this.rebuild();
      this.apply(change.removed, change.added);
    }
    if (this.pending.length) this.version++;
    this.pending = [];
  }

  private rebuild() {
    const set = this.resource.set!;
    this.set = set;
    this.pending = [];
    this.chunks.clear();
    this.count = 0;
    const d = set.data;
    for (let i = 0; i < set.count; i++) {
      this.insert(d.subarray(i * FLOATS, i * FLOATS + FLOATS));
    }
    this.version++;
  }

  private insert(r: ArrayLike<number>) {
    const cx = chunkOf(r[0]), cz = chunkOf(r[2]);
    const key = keyOf(cx, cz);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      this.chunks.set(
        key,
        chunk = { cx, cz, data: new Float32Array(16 * FLOATS), count: 0 },
      );
    }
    if ((chunk.count + 1) * FLOATS > chunk.data.length) {
      const grown = new Float32Array(chunk.data.length * 2);
      grown.set(chunk.data);
      chunk.data = grown;
    }
    chunk.data.set(r as ArrayLike<number>, chunk.count * FLOATS);
    chunk.count++;
    this.count++;
  }

  private apply(removed: Placement[], added: Placement[]) {
    for (const p of removed) {
      const chunk = this.chunks.get(keyOf(chunkOf(p.x), chunkOf(p.z)));
      if (!chunk) continue;
      const want = [p.x, p.y, p.z, p.yaw, p.scale, p.tint].map(Math.fround);
      for (let i = 0; i < chunk.count; i++) {
        let same = true;
        for (let k = 0; k < FLOATS; k++) {
          if (chunk.data[i * FLOATS + k] !== want[k]) {
            same = false;
            break;
          }
        }
        if (same) {
          chunk.data.copyWithin(
            i * FLOATS,
            (chunk.count - 1) * FLOATS,
            chunk.count * FLOATS,
          );
          chunk.count--;
          this.count--;
          break;
        }
      }
    }
    for (const p of added) {
      this.insert([p.x, p.y, p.z, p.yaw, p.scale, p.tint]);
    }
  }

  dispose() {
    this.off();
  }
}

// Depth pyramid -----------------------------------------------------------------------

interface HizKit {
  initPipeline: GPUComputePipeline;
  downPipeline: GPUComputePipeline;
  initLayout: GPUBindGroupLayout;
  downLayout: GPUBindGroupLayout;
}
const hizKits = new WeakMap<GPUDevice, HizKit>();
function hizKit(device: GPUDevice): HizKit {
  let kit = hizKits.get(device);
  if (kit) return kit;
  const C = ShaderStage.COMPUTE;
  const initLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: C,
        texture: { sampleType: "depth", multisampled: true },
      },
      {
        binding: 1,
        visibility: C,
        storageTexture: { access: "write-only", format: "r32float" },
      },
    ],
  });
  const downLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: C,
        texture: { sampleType: "unfilterable-float" },
      },
      {
        binding: 1,
        visibility: C,
        storageTexture: { access: "write-only", format: "r32float" },
      },
    ],
  });
  const make = (layout: GPUBindGroupLayout, code: string, entry: string) =>
    device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: device.createShaderModule({ code }),
        entryPoint: entry,
      },
    });
  kit = {
    initLayout,
    downLayout,
    initPipeline: make(initLayout, hizShader, "init"),
    downPipeline: make(downLayout, hizDownShader, "down"),
  };
  hizKits.set(device, kit);
  return kit;
}

/** Farthest-depth pyramid of the last frame's scene depth. */
export class Hiz {
  texture?: GPUTexture;
  view?: GPUTextureView;
  width = 0;
  height = 0;
  /** A real frame's depth has been captured. */
  valid = false;

  constructor(private core: Core) {}

  ensure(width: number, height: number) {
    const w = Math.max(1, Math.ceil(width / 2)),
      h = Math.max(1, Math.ceil(height / 2));
    if (this.texture && this.width === w && this.height === h) return;
    this.texture?.destroy();
    this.width = w;
    this.height = h;
    this.valid = false;
    this.texture = this.core.device.createTexture({
      label: "scene depth pyramid",
      size: [w, h],
      format: "r32float",
      mipLevelCount: Math.floor(Math.log2(Math.max(w, h))) + 1,
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.STORAGE_BINDING |
        TextureUsage.COPY_SRC,
    });
    this.view = this.texture.createView();
  }

  /** Reduce the multisampled scene depth into the pyramid. */
  build(encoder: GPUCommandEncoder, depth: GPUTexture) {
    const kit = hizKit(this.core.device);
    const texture = this.texture!;
    const pass = encoder.beginComputePass({ label: "depth pyramid" });
    pass.setPipeline(kit.initPipeline);
    pass.setBindGroup(
      0,
      this.core.device.createBindGroup({
        layout: kit.initLayout,
        entries: [
          {
            binding: 0,
            resource: depth.createView({ aspect: "depth-only" }),
          },
          {
            binding: 1,
            resource: texture.createView({
              baseMipLevel: 0,
              mipLevelCount: 1,
            }),
          },
        ],
      }),
    );
    pass.dispatchWorkgroups(
      Math.ceil(this.width / 8),
      Math.ceil(this.height / 8),
    );
    pass.setPipeline(kit.downPipeline);
    for (let level = 1; level < texture.mipLevelCount; level++) {
      const w = Math.max(1, this.width >> level),
        h = Math.max(1, this.height >> level);
      pass.setBindGroup(
        0,
        this.core.device.createBindGroup({
          layout: kit.downLayout,
          entries: [
            {
              binding: 0,
              resource: texture.createView({
                baseMipLevel: level - 1,
                mipLevelCount: 1,
              }),
            },
            {
              binding: 1,
              resource: texture.createView({
                baseMipLevel: level,
                mipLevelCount: 1,
              }),
            },
          ],
        }),
      );
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    }
    pass.end();
  }

  dispose() {
    this.texture?.destroy();
    this.texture = undefined;
  }
}

// Cull pipelines -------------------------------------------------------------------------

interface CullKit {
  layout0: GPUBindGroupLayout;
  layout2: GPUBindGroupLayout;
  cull: GPUComputePipeline;
  clamp: GPUComputePipeline;
  dummyHiz: GPUTextureView;
  dummyTerrain: GPUBindGroup;
  extras: GPUBuffer;
}
const cullKits = new WeakMap<GPUDevice, CullKit>();
function cullKit(core: Core): CullKit {
  let kit = cullKits.get(core.device);
  if (kit) return kit;
  const { device } = core;
  const C = ShaderStage.COMPUTE;
  const layout0 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: C, buffer: { type: "uniform" } },
      {
        binding: 1,
        visibility: C,
        texture: { sampleType: "unfilterable-float" },
      },
    ],
  });
  const layout2 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: C, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: C, buffer: { type: "storage" } },
      { binding: 2, visibility: C, buffer: { type: "storage" } },
    ],
  });
  const terrain = terrainKit(core);
  const module = device.createShaderModule({
    label: "scatter cull",
    code: scatterCullShader,
  });
  const layout = device.createPipelineLayout({
    bindGroupLayouts: [layout0, terrain.terrainLayout, layout2],
  });
  const dummy = (format: GPUTextureFormat, layers = 1) =>
    device.createTexture({
      size: [1, 1, layers],
      format,
      usage: TextureUsage.TEXTURE_BINDING,
    });
  const uniform = device.createBuffer({
    size: 256,
    usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
  });
  const hiz = dummy("r32float");
  kit = {
    layout0,
    layout2,
    cull: device.createComputePipeline({
      label: "scatter cull",
      layout,
      compute: { module, entryPoint: "cullInstances" },
    }),
    clamp: device.createComputePipeline({
      label: "scatter clamp",
      layout,
      compute: { module, entryPoint: "clampArgs" },
    }),
    dummyHiz: hiz.createView(),
    dummyTerrain: device.createBindGroup({
      layout: terrain.terrainLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: dummy("r32float").createView() },
        { binding: 2, resource: dummy("rg16float").createView() },
        {
          binding: 3,
          resource: dummy("rgba8unorm").createView({ dimension: "2d-array" }),
        },
        {
          binding: 4,
          resource: dummy("rgba8unorm").createView({ dimension: "2d-array" }),
        },
        {
          binding: 5,
          resource: dummy("rgba8unorm").createView({ dimension: "2d-array" }),
        },
        { binding: 6, resource: terrain.layerSampler },
        { binding: 7, resource: terrain.mapSampler },
      ],
    }),
    extras: device.createBuffer({
      label: "scatter joints and morphs",
      size: 256,
      usage: BufferUsage.STORAGE,
    }),
  };
  cullKits.set(device, kit);
  return kit;
}

// Layers ----------------------------------------------------------------------------------

export interface CullInput {
  camera: Camera;
  /** Clip matrices of the sun's cascades (at most four are culled). */
  cascades: readonly Mat4[];
  hiz: Hiz;
  viewportHeight: number;
  culling: "none" | "frustum" | "occlusion";
  previous: Mat4;
}

/** One scatter layer of one view. */
export class ScatterLayer {
  readonly resident: GrowBuffer;
  residentCount = 0;
  private residentKey = "";
  private chunkVersion = -1;
  private residentSet = new Set<number>();
  private params: GPUBuffer;
  private records?: GPUBuffer;
  private args?: GPUBuffer;
  private levels = 0;
  private mainCapacity = 0;
  private shadowCapacity = 0;
  private lists = 1;
  private group0?: GPUBindGroup;
  private group2?: GPUBindGroup;
  private group0Hiz?: GPUTextureView;
  private groups: GPUBindGroup[] = [];
  mesh?: GpuMesh;
  material?: GPUBindGroup;
  draw?: ScatterDraw;
  /** Placements the last cull considered, for statistics. */
  considered = 0;

  constructor(private core: Core, readonly index: ChunkIndex) {
    this.resident = new GrowBuffer(
      core.device,
      BufferUsage.STORAGE,
      "scatter placements",
      FLOATS * 4 * 1024,
    );
    this.params = core.device.createBuffer({
      label: "scatter cull",
      size: CULL_PARAM_FLOATS * 4,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
  }

  /** Prepare for the frame: residency, buffers. Returns false if the layer
   * cannot draw yet (assets loading). */
  update(
    draw: ScatterDraw,
    camera: Camera,
    frameNumber: number,
  ): boolean {
    this.draw = draw;
    const { assets } = this.core;
    const mesh = assets.getMesh(draw.mesh, frameNumber);
    if (!mesh) return false;
    this.mesh = mesh;
    const base = assets.getTexture(draw.texture);
    const normal = assets.getTexture(draw.normalMap, "normal");
    const orm = assets.getTexture(draw.ormMap, "orm");
    this.material = assets.material(base, normal, orm);
    this.index.sync();
    this.updateResident(draw, camera);
    this.ensureBuffers(mesh);
    return this.residentCount > 0;
  }

  private updateResident(draw: ScatterDraw, camera: Camera) {
    const cx = camera.position[0] - draw.position[0],
      cz = camera.position[2] - draw.position[2];
    const radius = draw.maxDistance + SCATTER_CHUNK * 0.75;
    const changed = this.chunkVersion !== this.index.version;
    const wanted: { chunk: Chunk; d: number }[] = [];
    const next = new Set<number>();
    for (const [key, chunk] of this.index.chunks) {
      if (!chunk.count) continue;
      const x0 = chunk.cx * SCATTER_CHUNK, z0 = chunk.cz * SCATTER_CHUNK;
      const dx = Math.max(x0 - cx, 0, cx - (x0 + SCATTER_CHUNK));
      const dz = Math.max(z0 - cz, 0, cz - (z0 + SCATTER_CHUNK));
      const d = Math.hypot(dx, dz);
      const limit = this.residentSet.has(key) ? radius + HYSTERESIS : radius;
      if (d <= limit) wanted.push({ chunk, d });
    }
    wanted.sort((a, b) => a.d - b.d);
    let total = 0;
    const keep: Chunk[] = [];
    for (const { chunk } of wanted) {
      if (total + chunk.count > RESIDENT_BUDGET) break;
      total += chunk.count;
      keep.push(chunk);
      next.add(keyOf(chunk.cx, chunk.cz));
    }
    const key = keep.map((c) => keyOf(c.cx, c.cz)).sort((a, b) => a - b)
      .join(",");
    if (!changed && key === this.residentKey) return;
    this.residentKey = key;
    this.chunkVersion = this.index.version;
    this.residentSet = next;
    const packed = new Float32Array(Math.max(1, total) * FLOATS);
    let at = 0;
    for (const chunk of keep) {
      packed.set(chunk.data.subarray(0, chunk.count * FLOATS), at);
      at += chunk.count * FLOATS;
    }
    if (this.resident.reserve(packed.byteLength)) this.group2 = undefined;
    this.core.device.queue.writeBuffer(this.resident.buffer, 0, packed);
    this.residentCount = total;
  }

  private ensureBuffers(mesh: GpuMesh) {
    const levels = Math.min(MAX_LEVELS, 1 + (mesh.lods?.length ?? 0));
    const main = Math.max(
      8,
      Math.ceil(Math.min(MAIN_CAPACITY, Math.max(8, this.residentCount)) / 8) *
        8,
    );
    const shadow = Math.max(
      8,
      Math.ceil(
        Math.min(SHADOW_CAPACITY, Math.max(8, this.residentCount)) / 8,
      ) * 8,
    );
    if (
      this.records && levels === this.levels && main === this.mainCapacity &&
      shadow === this.shadowCapacity
    ) return;
    this.records?.destroy();
    this.args?.destroy();
    this.levels = levels;
    this.mainCapacity = main;
    this.shadowCapacity = shadow;
    const device = this.core.device;
    const records = levels * main + (MAX_LISTS - 1) * levels * shadow;
    this.records = device.createBuffer({
      label: "scatter instances",
      size: records * INSTANCE_WORDS * 4,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC,
    });
    this.args = device.createBuffer({
      label: "scatter draw arguments",
      size: MAX_LISTS * levels * 5 * 4,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST | BufferUsage.COPY_SRC |
        0x100, /* INDIRECT */
    });
    this.group2 = undefined;
    const kit = cullKit(this.core);
    const layout = this.core.pipelines.instanceLayout;
    this.groups = [];
    for (let list = 0; list < MAX_LISTS; list++) {
      for (let level = 0; level < levels; level++) {
        const first = this.recordBase(list, level);
        const capacity = list === 0 ? main : shadow;
        this.groups.push(device.createBindGroup({
          layout,
          entries: [
            {
              binding: 0,
              resource: {
                buffer: this.records,
                offset: first * INSTANCE_WORDS * 4,
                size: capacity * INSTANCE_WORDS * 4,
              },
            },
            { binding: 1, resource: { buffer: kit.extras } },
            { binding: 2, resource: { buffer: kit.extras } },
          ],
        }));
      }
    }
  }

  private recordBase(list: number, level: number): number {
    return list === 0
      ? level * this.mainCapacity
      : this.levels * this.mainCapacity +
        ((list - 1) * this.levels + level) * this.shadowCapacity;
  }

  /** The bind group exposing one list's level as the instance buffer. */
  instances(list: number, level: number): GPUBindGroup {
    return this.groups[list * this.levels + level];
  }

  get levelCount(): number {
    return this.levels;
  }

  /** Record range of a list's level, for passes that bind it elsewhere. */
  range(list: number, level: number) {
    const capacity = list === 0 ? this.mainCapacity : this.shadowCapacity;
    return {
      buffer: this.records!,
      offset: this.recordBase(list, level) * INSTANCE_WORDS * 4,
      size: capacity * INSTANCE_WORDS * 4,
    };
  }

  /** Compute pass: build the lists. */
  encodeCull(
    pass: GPUComputePassEncoder,
    input: CullInput,
    terrain: TerrainGpu | undefined,
  ) {
    const draw = this.draw!, mesh = this.mesh!, device = this.core.device;
    const kit = cullKit(this.core);
    const lists = Math.min(MAX_LISTS, 1 + input.cascades.length);
    this.lists = lists;
    const viewProj = mat4.multiply(input.camera.projection, input.camera.view);
    const f = new Float32Array(CULL_PARAM_FLOATS);
    const bits = new Uint32Array(f.buffer);
    f.set(viewProj, 0);
    for (let i = 1; i < lists; i++) f.set(input.cascades[i - 1], i * 16);
    let at = MAX_LISTS * 16;
    f.set(input.previous, at);
    at += 16;
    const follow = draw.followTerrain && !!terrain;
    f.set([
      draw.position[0],
      draw.position[1],
      draw.position[2],
      follow ? 1 : 0,
    ], at);
    f.set([...input.camera.position, input.camera.near], at + 4);
    const ortho = input.camera.orthographic;
    const pixels = ortho
      ? 0
      : input.viewportHeight / 2 * input.camera.projection[5] * draw.lodBias;
    f.set([lists, this.residentCount, draw.maxDistance, pixels], at + 8);
    const hiz = input.hiz;
    const occlusion = input.culling === "occlusion" && hiz.valid && !ortho;
    f.set(
      [occlusion ? 1 : 0, hiz.width * 1, hiz.height * 1, input.camera.far],
      at + 12,
    );
    const box = mesh.bounds;
    const center = [0, 1, 2].map((k) => (box.min[k] + box.max[k]) / 2);
    const radius = Math.hypot(
      box.max[0] - box.min[0],
      box.max[1] - box.min[1],
      box.max[2] - box.min[2],
    ) / 2;
    f.set([center[0], center[1], center[2], radius], at + 16);
    f.set(draw.color, at + 20);
    f.set([
      draw.roughness,
      draw.metallic,
      draw.tintVariation,
      follow ? draw.alignToGround : 0,
    ], at + 24);
    const errors = [0, 0, 0, 0, 0].map((_, i) => mesh.lods?.[i]?.error ?? 0);
    f.set(errors.slice(0, 4), at + 28);
    bits[at + 32] = draw.entity;
    bits[at + 33] = draw.alphaMode === "mask" ? 1 : 0;
    new Float32Array(f.buffer)[at + 34] = draw.alphaCutoff;
    bits[at + 35] = this.levels;
    bits[at + 36] = this.mainCapacity;
    bits[at + 37] = this.shadowCapacity;
    bits[at + 38] = input.culling === "none" ? 0 : occlusion ? 2 : 1;
    device.queue.writeBuffer(this.params, 0, f);

    const template = new Uint32Array(MAX_LISTS * this.levels * 5);
    for (let list = 0; list < MAX_LISTS; list++) {
      for (let level = 0; level < this.levels; level++) {
        template[(list * this.levels + level) * 5] =
          lodGeometry(mesh, level).count;
      }
    }
    device.queue.writeBuffer(this.args!, 0, template);

    if (
      !this.group0 || this.group0Hiz !== (occlusion ? hiz.view : kit.dummyHiz)
    ) {
      this.group0Hiz = occlusion ? hiz.view : kit.dummyHiz;
      this.group0 = device.createBindGroup({
        layout: kit.layout0,
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: this.group0Hiz! },
        ],
      });
    }
    if (!this.group2) {
      this.group2 = device.createBindGroup({
        layout: kit.layout2,
        entries: [
          { binding: 0, resource: { buffer: this.resident.buffer } },
          { binding: 1, resource: { buffer: this.records! } },
          { binding: 2, resource: { buffer: this.args! } },
        ],
      });
    }
    pass.setBindGroup(0, this.group0);
    pass.setBindGroup(1, follow ? terrain!.bindGroup() : kit.dummyTerrain);
    pass.setBindGroup(2, this.group2);
    pass.setPipeline(kit.cull);
    pass.dispatchWorkgroups(Math.ceil(this.residentCount / CULL_WORKGROUP));
    pass.setPipeline(kit.clamp);
    pass.dispatchWorkgroups(lists);
    this.considered = this.residentCount;
  }

  /** Draw one list: every level with its own indirect draw. */
  drawList(
    pass: GPURenderPassEncoder,
    list: number,
    pipeline: GPURenderPipeline | null,
    group3?: (range: ReturnType<ScatterLayer["range"]>) => GPUBindGroup,
  ) {
    if (list >= this.lists || !this.mesh || !this.args) return;
    if (pipeline) pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.material!);
    pass.setVertexBuffer(0, this.mesh.vertex);
    for (let level = 0; level < this.levels; level++) {
      pass.setBindGroup(2, this.instances(list, level));
      if (group3) pass.setBindGroup(3, group3(this.range(list, level)));
      pass.setIndexBuffer(lodGeometry(this.mesh, level).index, "uint32");
      pass.drawIndexedIndirect(this.args, (list * this.levels + level) * 20);
    }
  }

  /** Instances kept per list and level, read back (tests, statistics). */
  async counts(): Promise<number[][]> {
    const { device } = this.core;
    const size = MAX_LISTS * this.levels * 5 * 4;
    const staging = device.createBuffer({
      size,
      usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.args!, 0, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(1);
    const words = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    const out: number[][] = [];
    for (let list = 0; list < MAX_LISTS; list++) {
      out.push(
        Array.from(
          { length: this.levels },
          (_, level) => words[(list * this.levels + level) * 5 + 1],
        ),
      );
    }
    return out;
  }

  /** Translation of every instance kept per list and level, read back
   * (tests): `[list][level]` is a flat `x, y, z` array. */
  async positions(): Promise<Float32Array[][]> {
    const counts = await this.counts();
    const { device } = this.core;
    const size = this.records!.size;
    const staging = device.createBuffer({
      size,
      usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.records!, 0, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(1);
    const words = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return counts.map((levels, list) =>
      levels.map((count, level) => {
        const capacity = list === 0 ? this.mainCapacity : this.shadowCapacity;
        const out = new Float32Array(Math.min(count, capacity) * 3);
        const base = this.recordBase(list, level);
        for (let i = 0; i < out.length / 3; i++) {
          const at = (base + i) * INSTANCE_WORDS + 12;
          out.set(words.subarray(at, at + 3), i * 3);
        }
        return out;
      })
    );
  }

  dispose() {
    this.resident.destroy();
    this.records?.destroy();
    this.args?.destroy();
    this.params.destroy();
  }
}
