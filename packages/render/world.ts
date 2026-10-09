/**
 * Large-world content of a frame: terrains (quadtree patches) and scatter
 * layers (GPU-culled instances). `WorldShared` (one per renderer) owns the
 * GPU copies of terrain data; `WorldView` (one per view) chooses what to draw
 * from the camera and owns the per-view buffers. Passes draw the result with
 * `drawWorld`, the way they draw the plan's batches.
 *
 * Lists: every pass has an index. List 0 is the camera; the sun's cascades
 * follow (1 + cascade).
 */
import { type Aabb, type Mat4, mat4 } from "@ink/geometry";
import type { Core } from "./core.ts";
import { BufferUsage, GrowBuffer } from "./gpu.ts";
import { PATCH_INDICES } from "./shaders/terrain.ts";
import { ChunkIndex, Hiz, ScatterLayer } from "./scatter_gpu.ts";
import { type NodeList, TerrainGpu } from "./terrain_gpu.ts";
import { kitOf, type TerrainPass } from "./terrain_pipelines.ts";
import type { Camera, Overlays, RenderScene, TerrainDraw } from "./types.ts";

/** Terrain data every view of a renderer shares. */
export class WorldShared {
  terrains = new Map<string, TerrainGpu>();
  private indices = new Map<string, ChunkIndex>();

  /** The chunked placements of a scatter asset. */
  chunks(core: Core, path: string): ChunkIndex {
    const resource = core.assets.scatter(path);
    let index = this.indices.get(path);
    if (!index || index["resource"] !== resource) {
      index?.dispose();
      this.indices.set(path, index = new ChunkIndex(resource));
    }
    return index;
  }

  terrain(core: Core, path: string): TerrainGpu {
    let gpu = this.terrains.get(path);
    const resource = core.assets.terrain(path);
    if (!gpu || gpu.resource !== resource) {
      gpu?.dispose();
      this.terrains.set(path, gpu = new TerrainGpu(core, resource));
    }
    return gpu;
  }

  dispose() {
    for (const t of this.terrains.values()) t.dispose();
    this.terrains.clear();
    for (const i of this.indices.values()) i.dispose();
    this.indices.clear();
  }
}

export interface TerrainFrame {
  gpu: TerrainGpu;
  draw: TerrainDraw;
  /** First node and node count of every list. */
  ranges: { first: number; count: number }[];
}

/** What a view draws this frame. */
export interface WorldFrame {
  terrains: TerrainFrame[];
  scatters: ScatterLayer[];
  /** Changes whenever the world's shadow-casting geometry may have changed. */
  signature: number;
  nodesGroup: GPUBindGroup;
  /** Patches selected for the camera, for statistics. */
  patches: number;
}

export interface WorldDrawOptions {
  /** Pipeline for scatter instances; `null` keeps the one the pass set. */
  scatter?: ((doubleSided: boolean) => GPURenderPipeline) | null;
  /** Group 3 for scatter draws (motion vectors bind the instance range). */
  group3?: (range: {
    buffer: GPUBuffer;
    offset: number;
    size: number;
  }) => GPUBindGroup;
}

export class WorldView {
  private nodes: GrowBuffer;
  private nodesGroup?: GPUBindGroup;
  private frame?: WorldFrame;
  private pending: { terrain: TerrainFrame; lists: NodeList[] }[] = [];
  private camera?: Camera;
  private layers = new Map<number, ScatterLayer>();
  private hiz?: Hiz;
  private drawnDepth?: GPUTexture;
  private drawnFrames = 0;
  private previous: Mat4 = mat4.identity();
  private viewportHeight = 1;
  private culling: "none" | "frustum" | "occlusion" = "occlusion";
  private cascades: readonly Mat4[] = [];
  private scatterTerrain?: TerrainGpu;

  constructor(private core: Core) {
    this.nodes = new GrowBuffer(
      core.device,
      BufferUsage.STORAGE,
      "terrain nodes",
      4096,
    );
  }

  /** Update GPU data and select the camera's patches. Returns undefined when
   * the scene has no large-world content. */
  update(
    scene: RenderScene,
    camera: Camera,
    overlays: Overlays,
    shared: WorldShared,
    frameNumber: number,
    viewportHeight: number,
  ): WorldFrame | undefined {
    this.pending = [];
    this.camera = camera;
    this.frame = undefined;
    this.viewportHeight = viewportHeight;
    this.culling = overlays.culling ?? "occlusion";
    if (overlays.resetHistory) this.drawnFrames = 0;
    const draws = scene.terrains ?? [];
    const scatters = scene.scatters ?? [];
    const wire = overlays.shading === "wireframe";
    if ((!draws.length && !scatters.length) || wire) {
      this.dropLayers(new Set());
      return undefined;
    }
    const viewProj = mat4.multiply(camera.projection, camera.view);
    let signature = 0x811c9dc5;
    const terrains: TerrainFrame[] = [];
    for (const draw of draws) {
      const gpu = shared.terrain(this.core, draw.heightmap);
      gpu.update(draw, camera, overlays.still === true);
      if (!gpu.ready) continue;
      const list: NodeList = { data: [], count: 0 };
      gpu.select(draw, camera, viewProj, list);
      const terrain: TerrainFrame = { gpu, draw, ranges: [] };
      terrains.push(terrain);
      this.pending.push({ terrain, lists: [list] });
      signature = mix(signature, gpu.resource.version);
      signature = mix(signature, gpu.groupId);
    }
    this.scatterTerrain = terrains[0]?.gpu;
    const active: ScatterLayer[] = [];
    const seen = new Set<number>();
    for (const draw of scatters) {
      const resource = this.core.assets.scatter(draw.placements);
      if (resource.state !== "ready") continue;
      const index = shared.chunks(this.core, draw.placements);
      let layer = this.layers.get(draw.entity);
      if (!layer || layer.index !== index) {
        layer?.dispose();
        this.layers.set(
          draw.entity,
          layer = new ScatterLayer(this.core, index),
        );
      }
      seen.add(draw.entity);
      if (layer.update(draw, camera, frameNumber)) {
        active.push(layer);
        signature = mix(signature, index.version);
        signature = mix(signature, resource.revision);
      }
    }
    this.dropLayers(seen);
    if (!terrains.length && !active.length) return undefined;
    this.frame = {
      terrains,
      scatters: active,
      signature,
      nodesGroup: undefined as unknown as GPUBindGroup,
      patches: this.pending.reduce((n, p) => n + p.lists[0].count, 0),
    };
    return this.frame;
  }

  private dropLayers(keep: Set<number>) {
    for (const [entity, layer] of this.layers) {
      if (!keep.has(entity)) {
        layer.dispose();
        this.layers.delete(entity);
      }
    }
  }

  /** Add the lists of the sun's cascades (clip matrices) and upload. */
  finish(cascades: readonly Mat4[]) {
    const frame = this.frame;
    this.cascades = cascades;
    if (!frame || !this.camera) return;
    for (const entry of this.pending) {
      for (const matrix of cascades) {
        const list: NodeList = { data: [], count: 0 };
        if (entry.terrain.draw.castShadows) {
          entry.terrain.gpu.select(
            entry.terrain.draw,
            this.camera,
            matrix,
            list,
          );
        }
        entry.lists.push(list);
      }
    }
    // One storage buffer per view: [camera] then every list's nodes.
    let total = 1;
    for (const e of this.pending) {
      for (const l of e.lists) total += l.count;
    }
    const data = new Float32Array(total * 4);
    data.set([...this.camera.position, 0], 0);
    let at = 1;
    for (const e of this.pending) {
      e.terrain.ranges = [];
      for (const l of e.lists) {
        e.terrain.ranges.push({ first: at - 1, count: l.count });
        data.set(l.data, at * 4);
        at += l.count;
      }
    }
    const grown = this.nodes.reserve(data.byteLength);
    if (grown || !this.nodesGroup) {
      this.nodesGroup = this.core.device.createBindGroup({
        label: "terrain nodes",
        layout: kitOf(this.core).nodesLayout,
        entries: [{ binding: 0, resource: { buffer: this.nodes.buffer } }],
      });
    }
    this.core.device.queue.writeBuffer(this.nodes.buffer, 0, data);
    frame.nodesGroup = this.nodesGroup;
  }

  /** Record the depth pyramid and the scatter culling, before any pass that
   * draws the world. `depth` holds the previous frame's scene depth. */
  encode(
    encoder: GPUCommandEncoder,
    depth: GPUTexture,
    width: number,
    height: number,
  ) {
    const frame = this.frame;
    if (!frame?.scatters.length || !this.camera) return;
    const wantsHiz = this.culling === "occlusion" &&
      !this.camera.orthographic;
    this.hiz ??= new Hiz(this.core);
    if (wantsHiz && this.drawnDepth === depth && this.drawnFrames > 0) {
      this.hiz.ensure(width, height);
      this.hiz.build(encoder, depth);
      this.hiz.valid = true;
    } else this.hiz.valid = false;
    const pass = encoder.beginComputePass({ label: "scatter culling" });
    for (const layer of frame.scatters) {
      layer.encodeCull(
        pass,
        {
          camera: this.camera,
          cascades: this.cascades.slice(0, 4),
          hiz: this.hiz,
          viewportHeight: this.viewportHeight,
          culling: this.culling,
          previous: this.previous,
        },
        this.scatterTerrain,
      );
    }
    pass.end();
  }

  /** The frame was submitted: its depth is what the next frame culls with. */
  frameDone(depth: GPUTexture, camera: Camera) {
    this.drawnDepth = depth;
    this.drawnFrames++;
    this.previous = mat4.multiply(camera.projection, camera.view);
  }

  /** Instances kept per list and level for every scatter layer (read back). */
  async scatterCounts() {
    const out: { entity: number; counts: number[][]; resident: number }[] = [];
    for (const [entity, layer] of this.layers) {
      out.push({
        entity,
        counts: await layer.counts(),
        resident: layer.residentCount,
      });
    }
    return out;
  }

  /** Where every kept scatter instance sits (read back; tests). */
  async scatterPositions() {
    const out: { entity: number; positions: Float32Array[][] }[] = [];
    for (const [entity, layer] of this.layers) {
      out.push({ entity, positions: await layer.positions() });
    }
    return out;
  }

  /** The terrain's world-space bounds as shadow casters. */
  casterBounds(): Aabb[] {
    return this.pending.filter((p) => p.terrain.draw.castShadows).map((p) =>
      p.terrain.gpu.worldBounds(p.terrain.draw) as unknown as Aabb
    );
  }

  dispose() {
    this.nodes.destroy();
    this.dropLayers(new Set());
    this.hiz?.dispose();
  }
}

/** Draw the terrains and scatter layers of a list into a pass whose group 0
 * is already set. */
export function drawWorld(
  pass: GPURenderPassEncoder,
  core: Core,
  frame: WorldFrame | undefined,
  kind: TerrainPass,
  list: number,
  options: WorldDrawOptions = {},
) {
  if (!frame) return;
  const { pipelines } = core;
  const pick = (double: boolean) => {
    if (options.scatter !== undefined) {
      return options.scatter ? options.scatter(double) : null;
    }
    if (kind === "lit") return double ? pipelines.litDouble : pipelines.lit;
    if (kind === "pick") return double ? pipelines.pickDouble : pipelines.pick;
    return null;
  };
  for (const layer of frame.scatters) {
    if (list > 0 && !layer.draw!.castShadows) continue;
    layer.drawList(pass, list, pick(layer.draw!.doubleSided), options.group3);
  }
  const kit = kitOf(core);
  let bound = false;
  for (const t of frame.terrains) {
    const range = t.ranges[list];
    if (!range || range.count === 0) continue;
    if (!bound) {
      pass.setPipeline(kit.pipeline(kind));
      pass.setIndexBuffer(kit.patchIndex, "uint32");
      pass.setBindGroup(2, frame.nodesGroup);
      bound = true;
    }
    pass.setBindGroup(1, t.gpu.bindGroup());
    pass.drawIndexed(PATCH_INDICES, range.count, 0, 0, range.first);
  }
}

function mix(h: number, word: number): number {
  return Math.imul(h ^ (word | 0), 0x01000193) >>> 0;
}
