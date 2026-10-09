/**
 * A View draws a RenderScene into a canvas or an offscreen size. Frame:
 *
 *   systems      prepare (CPU) then encode: sun cascades, spot and point
 *                shadow maps, AO, environment probes, see systems.ts
 *   main         4x MSAA, linear HDR scene radiance (sky, meshes, wireframe),
 *                stored tonemap-weighted, resolved to a single sample
 *   overlay      4x MSAA RGBA8 premultiplied layer: grid, fills, lines, tested
 *                against the scene depth; resolved (skipped when empty)
 *   post         decode, auto exposure, bloom, composite: exposure, grading,
 *                tonemap, vignette, grain, overlay (post/chain.ts)
 *   mask         selection / hover mask, tested against the scene depth
 *   final        selection outline, sRGB encode and blue-noise dither
 */
import { encodeFinal, readFrame } from "./capture.ts";
import type { Core } from "./core.ts";
import { resolveEnvironment } from "./environment.ts";
import { type FrameData, packFrame } from "./frame.ts";
import {
  BufferUsage,
  COLOR_FORMAT,
  DEPTH_FORMAT,
  GrowBuffer,
  OVERLAY_FORMAT,
  SAMPLES,
  srgbToLinear,
  texture2d,
  TextureUsage,
} from "./gpu.ts";
import { buildOverlays, FILL_FLOATS, LINE_FLOATS } from "./overlays.ts";
import { Picker, type PickFrame } from "./pick.ts";
import { buildPlan } from "./plan.ts";
import { encodePng } from "./png.ts";
import { PostChain } from "./post/chain.ts";
import {
  FRAME,
  FRAME_FLOATS,
  LIGHT_FLOATS,
  MAX_LIGHTS,
  MAX_SHADOW_MATRICES,
} from "./shaders/frame_layout.ts";
import {
  drawPlan,
  type FrameContext,
  type PrepareContext,
  type RenderSystem,
  type SystemBindings,
} from "./systems.ts";
import { AmbientOcclusionSystem } from "./systems/ao.ts";
import { ClusteredLightSystem } from "./systems/clusters.ts";
import { EnvironmentLightSystem } from "./systems/environment_light.ts";
import { LocalShadowSystem } from "./systems/local_shadows.ts";
import { SunShadowSystem } from "./systems/shadows.ts";
import { ParticleSystem } from "./systems/particles.ts";
import { Temporal } from "./temporal.ts";
import { Lightmaps } from "./lightmaps.ts";
import { ScreenReflections } from "./ssr.ts";
import type {
  Camera,
  Overlays,
  Pick,
  PixelData,
  RenderScene,
  View,
} from "./types.ts";

type Target = HTMLCanvasElement | OffscreenCanvas | {
  width: number;
  height: number;
};

interface Targets {
  width: number;
  height: number;
  color: GPUTexture;
  depth: GPUTexture;
  resolve: GPUTexture;
  mask: GPUTexture;
  maskResolve: GPUTexture;
}

interface OverlayTargets {
  color: GPUTexture;
  resolve: GPUTexture;
  resolveView: GPUTextureView;
}

const DEFAULT_BACKGROUND = [0.105, 0.115, 0.14, 1] as const;

export class ViewImpl implements View {
  width: number;
  height: number;
  private cssWidth: number;
  private cssHeight: number;
  private dpr = 1;
  private canvas?: HTMLCanvasElement | OffscreenCanvas;
  private context?: GPUCanvasContext;
  private targets?: Targets;
  private overlayTargets?: OverlayTargets;
  private transparentTargets?: OverlayTargets;
  private frameBuffer: GPUBuffer;
  private lightBuffer: GPUBuffer;
  private shadowMatrixBuffer: GPUBuffer;
  private gridBuffer: GPUBuffer;
  private finalBuffer: GPUBuffer;
  private instances: GrowBuffer;
  private joints: GrowBuffer;
  private morphs: GrowBuffer;
  private lines: GrowBuffer;
  private fills: GrowBuffer;
  /** Frame group with every extension slot on a dummy. */
  private neutralGroup: GPUBindGroup;
  private frameGroup: GPUBindGroup;
  private frameGroupKey = "";
  private instanceGroup?: GPUBindGroup;
  private linesGroup?: GPUBindGroup;
  private fillsGroup?: GPUBindGroup;
  private gridGroup: GPUBindGroup;
  private finalGroup?: GPUBindGroup;
  private picker: Picker;
  private systems: RenderSystem[];
  private environmentLight = new EnvironmentLightSystem();
  private clusters = new ClusteredLightSystem();
  private particles?: ParticleSystem;
  private post: PostChain;
  private temporal?: Temporal;
  private lightmaps: Lightmaps;
  private reflections?: ScreenReflections;
  private lastTime = 0;
  /** Frames this view rendered: seeds its animated noise, so a fresh view
   * renders the same picture wherever other views are in their frames. */
  private frameIndex = 0;
  private last?: {
    scene: RenderScene;
    camera: Camera;
    overlays: Overlays;
    pickFrame: PickFrame;
  };
  /** Statistics of the last frame, for tests and tools. */
  stats = {
    lightmapSamples: 0,
    lightmapCharts: 0,
    reflectionProbes: 0,
    pendingWork: false,
    passes: 0,
    environmentBakes: 0,
    lights: 0,
    clusters: 0,
    particles: 0,
    temporalFrames: 0,
    renderWidth: 0,
    renderHeight: 0,
  };
  private unsubscribe: () => void;
  private redrawQueued = false;
  private disposed = false;

  constructor(private core: Core, target: Target) {
    this.lightmaps = new Lightmaps(core);
    const { device, pipelines } = core;
    if ("getContext" in target) {
      this.canvas = target;
      const context = target.getContext("webgpu") as GPUCanvasContext | null;
      if (!context) throw new Error("canvas has no webgpu context");
      this.context = context;
      context.configure({
        device,
        format: core.format,
        alphaMode: "opaque",
        usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC,
      });
    }
    this.width = Math.max(1, target.width);
    this.height = Math.max(1, target.height);
    this.cssWidth = this.width;
    this.cssHeight = this.height;

    const buffer = (label: string, bytes: number, usage: number) =>
      device.createBuffer({
        label,
        size: bytes,
        usage: usage | BufferUsage.COPY_DST,
      });
    this.frameBuffer = buffer("frame", FRAME_FLOATS * 4, BufferUsage.UNIFORM);
    this.lightBuffer = buffer(
      "lights",
      MAX_LIGHTS * LIGHT_FLOATS * 4,
      BufferUsage.STORAGE,
    );
    this.shadowMatrixBuffer = buffer(
      "shadow-matrices",
      MAX_SHADOW_MATRICES * 64,
      BufferUsage.STORAGE,
    );
    this.gridBuffer = buffer("grid", 80, BufferUsage.UNIFORM);
    this.finalBuffer = buffer("final", 64, BufferUsage.UNIFORM);
    this.instances = new GrowBuffer(
      device,
      BufferUsage.STORAGE,
      "instances",
      4096,
    );
    this.lines = new GrowBuffer(device, BufferUsage.STORAGE, "lines", 1024);
    this.joints = new GrowBuffer(
      device,
      BufferUsage.STORAGE,
      "skin joints",
      128,
    );
    this.morphs = new GrowBuffer(
      device,
      BufferUsage.STORAGE,
      "morph targets",
      256,
    );
    this.fills = new GrowBuffer(device, BufferUsage.STORAGE, "fills", 1024);
    this.neutralGroup = this.makeFrameGroup({});
    this.frameGroup = this.neutralGroup;
    this.gridGroup = device.createBindGroup({
      layout: pipelines.gridLayout,
      entries: [{ binding: 2, resource: { buffer: this.gridBuffer } }],
    });
    this.systems = [
      this.clusters,
      new SunShadowSystem(),
      new LocalShadowSystem(),
      new AmbientOcclusionSystem(),
      this.environmentLight,
    ];
    this.post = new PostChain(core);
    this.picker = new Picker(core);
    this.unsubscribe = core.assets.onChange(() => this.queueRedraw());
  }

  // Sizing --------------------------------------------------------------------

  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    this.dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
    this.width = Math.max(1, Math.round(this.cssWidth * this.dpr));
    this.height = Math.max(1, Math.round(this.cssHeight * this.dpr));
    if (this.canvas) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
  }

  // Resources -----------------------------------------------------------------

  /** The frame group (group 0) with the systems' resources; dummies fill the
   * slots no system provides. */
  private makeFrameGroup(b: SystemBindings): GPUBindGroup {
    const { device, pipelines, dummies: d } = this.core;
    return device.createBindGroup({
      label: "frame",
      layout: pipelines.frameLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: b.sunShadow ?? d.sunShadow },
        { binding: 2, resource: d.shadowSampler },
        { binding: 3, resource: b.spotShadow ?? d.spotShadow },
        { binding: 4, resource: b.pointShadow ?? d.pointShadow },
        { binding: 5, resource: b.ao ?? d.ao },
        { binding: 6, resource: d.linearSampler },
        { binding: 7, resource: b.environment ?? d.cube },
        { binding: 8, resource: b.specular ?? d.cube },
        { binding: 9, resource: b.brdfLut ?? d.brdfLut },
        { binding: 10, resource: d.blueNoise },
        { binding: 11, resource: { buffer: this.lightBuffer } },
        { binding: 12, resource: { buffer: this.shadowMatrixBuffer } },
        { binding: 13, resource: b.pointFaces ?? d.pointFaces },
        { binding: 14, resource: { buffer: b.clusters ?? d.clusters } },
        { binding: 15, resource: b.lightmap ?? d.black },
        {
          binding: 16,
          resource: { buffer: b.lightmapCharts ?? d.lightmapCharts },
        },
        { binding: 17, resource: b.probeCubes ?? d.probeCubes },
        { binding: 18, resource: { buffer: b.probes ?? d.probes } },
      ],
    });
  }

  /** Reuse the frame group while the systems' views stay the same objects. */
  private frameGroupFor(b: SystemBindings): GPUBindGroup {
    const ids = [
      b.sunShadow,
      b.spotShadow,
      b.pointShadow,
      b.pointFaces,
      b.ao,
      b.environment,
      b.specular,
      b.brdfLut,
      b.clusters,
      b.lightmap,
      b.lightmapCharts,
      b.probeCubes,
      b.probes,
    ].map((v) => (v ? viewId(v) : 0));
    const key = ids.join(",");
    if (key !== this.frameGroupKey) {
      this.frameGroupKey = key;
      this.frameGroup = ids.every((id) => id === 0)
        ? this.neutralGroup
        : this.makeFrameGroup(b);
    }
    return this.frameGroup;
  }

  private ensureTargets(width: number, height: number): Targets {
    const t = this.targets;
    if (t && t.width === width && t.height === height) return t;
    this.releaseTargets();
    const d = this.core.device;
    const attach = TextureUsage.RENDER_ATTACHMENT;
    const sampled = TextureUsage.TEXTURE_BINDING;
    this.targets = {
      width,
      height,
      color: texture2d(
        d,
        "color-msaa",
        width,
        height,
        COLOR_FORMAT,
        attach,
        SAMPLES,
      ),
      depth: texture2d(
        d,
        "depth-msaa",
        width,
        height,
        DEPTH_FORMAT,
        attach,
        SAMPLES,
      ),
      resolve: texture2d(
        d,
        "color",
        width,
        height,
        COLOR_FORMAT,
        attach | sampled,
      ),
      mask: texture2d(
        d,
        "mask-msaa",
        width,
        height,
        "rg8unorm",
        attach,
        SAMPLES,
      ),
      maskResolve: texture2d(
        d,
        "mask",
        width,
        height,
        "rg8unorm",
        attach | sampled,
      ),
    };
    this.post.resize(width, height);
    return this.targets;
  }

  private ensureOverlayTargets(t: Targets): OverlayTargets {
    if (!this.overlayTargets) {
      const d = this.core.device;
      const resolve = texture2d(
        d,
        "overlay",
        t.width,
        t.height,
        OVERLAY_FORMAT,
        TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
      );
      this.overlayTargets = {
        color: texture2d(
          d,
          "overlay-msaa",
          t.width,
          t.height,
          OVERLAY_FORMAT,
          TextureUsage.RENDER_ATTACHMENT,
          SAMPLES,
        ),
        resolve,
        resolveView: resolve.createView(),
      };
    }
    return this.overlayTargets;
  }

  private releaseTargets() {
    const t = this.targets;
    if (!t) return;
    for (const tex of [t.color, t.depth, t.resolve, t.mask, t.maskResolve]) {
      tex.destroy();
    }
    this.overlayTargets?.color.destroy();
    this.overlayTargets?.resolve.destroy();
    this.overlayTargets = undefined;
    this.releaseTransparency();
    this.targets = undefined;
    this.finalGroup = undefined;
  }

  private releaseTransparency() {
    this.transparentTargets?.color.destroy();
    this.transparentTargets?.resolve.destroy();
    this.transparentTargets = undefined;
  }

  private ensureTransparency(t: Targets): OverlayTargets {
    if (!this.transparentTargets) {
      const d = this.core.device;
      const resolve = texture2d(
        d,
        "transparency",
        t.width,
        t.height,
        COLOR_FORMAT,
        TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
      );
      this.transparentTargets = {
        color: texture2d(
          d,
          "transparency-msaa",
          t.width,
          t.height,
          COLOR_FORMAT,
          TextureUsage.RENDER_ATTACHMENT,
          SAMPLES,
        ),
        resolve,
        resolveView: resolve.createView(),
      };
    }
    return this.transparentTargets;
  }

  // Rendering -----------------------------------------------------------------

  render(scene: RenderScene, camera: Camera, overlays: Overlays = {}): void {
    if (this.disposed || this.core.lost) return;
    const { device, pipelines, assets } = this.core;
    const frameNumber = ++this.core.frame;
    const scale = Number.isFinite(overlays.renderScale)
      ? Math.max(0.5, Math.min(1, overlays.renderScale!))
      : 1;
    const width = Math.max(1, Math.round(this.width * scale));
    const height = Math.max(1, Math.round(this.height * scale));
    const targets = this.ensureTargets(width, height);
    const quality = overlays.quality ?? this.core.quality;
    const environment = resolveEnvironment(
      scene.environment,
      overlays.environment,
    );
    const still = overlays.still === true;
    const wall = performance.now() / 1000;
    const dt = still
      ? 0
      : this.lastTime
      ? Math.min(wall - this.lastTime, 0.25)
      : 0;
    this.lastTime = wall;
    const now = still ? 0 : wall;
    const viewFrame = still ? 0 : ++this.frameIndex;

    const plan = buildPlan(scene, overlays, assets, frameNumber, camera);
    this.lightmaps.prepare(
      scene,
      plan,
      environment,
      overlays.shading === "unlit" || overlays.shading === "wireframe",
    );
    const temporal = overlays.temporal && !still &&
      overlays.shading !== "wireframe";
    let rasterCamera = camera;
    if (temporal) {
      this.temporal ??= new Temporal(this.core);
      rasterCamera = this.temporal.prepare(
        plan,
        camera,
        { width, height, outputWidth: this.width, outputHeight: this.height },
        assets.version,
        scene.tick,
        overlays.resetHistory,
      );
    } else {
      this.temporal?.dispose();
      this.temporal = undefined;
    }
    const jitter = this.temporal?.jitter ?? [0, 0];
    const extra = buildOverlays(scene, overlays);
    const frame: FrameData = packFrame(
      rasterCamera,
      { ...overlays, temporal: !!temporal },
      environment,
      scene.lights,
      plan.casterBounds,
      { width, height, dpr: this.dpr * scale },
      quality,
      viewFrame,
      now,
    );

    // Upload geometry-side buffers first: the instance buffer may be replaced.
    frame.data.set(
      [this.lightmaps.probeCount, this.lightmaps.probeMips],
      FRAME.gi + 1,
    );
    const newInstances = this.instances.reserve(plan.data.byteLength);
    const newJoints = this.joints.reserve(plan.joints.byteLength);
    const newMorphs = this.morphs.reserve(plan.morphs.byteLength);
    if (newInstances || newJoints || newMorphs || !this.instanceGroup) {
      this.instanceGroup = device.createBindGroup({
        layout: pipelines.instanceLayout,
        entries: [
          { binding: 0, resource: { buffer: this.instances.buffer } },
          { binding: 1, resource: { buffer: this.joints.buffer } },
          { binding: 2, resource: { buffer: this.morphs.buffer } },
        ],
      });
    }
    device.queue.writeBuffer(this.instances.buffer, 0, plan.data);
    device.queue.writeBuffer(this.joints.buffer, 0, plan.joints);
    device.queue.writeBuffer(this.morphs.buffer, 0, plan.morphs);
    const instanceGroup = this.instanceGroup;
    const lineCount = extra.testedLines + extra.overlayLines;
    if (
      this.lines.reserve(Math.max(1, lineCount) * LINE_FLOATS * 4) ||
      !this.linesGroup
    ) {
      this.linesGroup = device.createBindGroup({
        layout: pipelines.linesLayout,
        entries: [{ binding: 0, resource: { buffer: this.lines.buffer } }],
      });
    }
    if (lineCount) device.queue.writeBuffer(this.lines.buffer, 0, extra.lines);
    if (
      this.fills.reserve(Math.max(1, extra.fillVertices) * FILL_FLOATS * 4) ||
      !this.fillsGroup
    ) {
      this.fillsGroup = device.createBindGroup({
        layout: pipelines.fillsLayout,
        entries: [{ binding: 1, resource: { buffer: this.fills.buffer } }],
      });
    }
    if (extra.fillVertices) {
      device.queue.writeBuffer(this.fills.buffer, 0, extra.fills);
    }
    if (extra.grid) device.queue.writeBuffer(this.gridBuffer, 0, extra.grid);

    const flagged = plan.batches.some((b) => b.flagged);
    const sel = srgbToLinear;
    device.queue.writeBuffer(
      this.finalBuffer,
      0,
      new Float32Array([
        this.width,
        this.height,
        Math.max(1, 2 * this.dpr),
        flagged ? 1 : 0,
        sel(1),
        sel(0.6),
        sel(0.14),
        1,
        sel(0.9),
        sel(0.95),
        sel(1),
        0.85,
        jitter[0],
        jitter[1],
        0,
        0,
      ]),
    );

    // Systems: CPU preparation, then the frame uniform, then GPU work.
    const prepare: PrepareContext = {
      core: this.core,
      scene,
      camera,
      rasterCamera,
      overlays: { ...overlays, temporal: !!temporal },
      environment,
      quality,
      frame,
      write: (field, values, at = 0) =>
        frame.data.set(values, FRAME[field] + at),
      shadowMatrices: this.shadowMatrixBuffer,
      lightBuffer: this.lightBuffer,
      casterBounds: plan.casterBounds,
      width,
      height,
    };
    const bindings: SystemBindings = {};
    Object.assign(bindings, this.lightmaps.bindings());
    for (const system of this.systems) system.prepare?.(prepare);
    for (const system of this.systems) {
      Object.assign(bindings, system.bindings());
    }
    device.queue.writeBuffer(this.frameBuffer, 0, frame.data);
    device.queue.writeBuffer(this.lightBuffer, 0, frame.lights);
    const frameGroup = this.frameGroupFor(bindings);

    const encoder = device.createCommandEncoder({ label: "frame" });
    const context: FrameContext = {
      ...prepare,
      encoder,
      plan,
      neutralGroup: this.neutralGroup,
      instanceGroup,
      frameBuffer: this.frameBuffer,
    };
    let passes = 0;
    passes += this.lightmaps.encode(encoder, still);
    for (const system of this.systems) passes += system.encode(context) ?? 0;

    if (scene.particles?.length && overlays.shading !== "wireframe") {
      this.particles ??= new ParticleSystem(this.core);
      passes += this.particles.encode(encoder, scene.particles, camera);
    } else {
      this.particles?.dispose();
      this.particles = undefined;
    }

    // Main pass: scene radiance in linear HDR.
    const wireframe = overlays.shading === "wireframe";
    const flat = overlays.background ??
      (overlays.shading === "lit" || overlays.shading === undefined
        ? undefined
        : [...DEFAULT_BACKGROUND]);
    const depthView = targets.depth.createView();
    const main = encoder.beginRenderPass({
      colorAttachments: [{
        view: targets.color.createView(),
        resolveTarget: targets.resolve.createView(),
        // Alpha 0 marks pixels the scene did not cover (flat background).
        clearValue: [0, 0, 0, 0],
        loadOp: "clear",
        storeOp: "discard",
      }],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    main.setBindGroup(0, frameGroup);
    if (!flat) {
      main.setPipeline(pipelines.sky);
      main.draw(3);
    }
    if (wireframe) {
      main.setPipeline(pipelines.prepass);
      drawPlan(main, { plan, instanceGroup });
      main.setPipeline(pipelines.wire);
      main.setBindGroup(2, instanceGroup);
      for (const b of plan.batches) {
        if (b.brush) continue;
        const edges = assets.edges(b.mesh);
        main.setBindGroup(1, b.material);
        main.setVertexBuffer(0, b.mesh.vertex);
        main.setIndexBuffer(edges, "uint32");
        main.drawIndexed(b.mesh.edgeCount, b.count, 0, 0, b.first);
      }
    } else {
      main.setPipeline(pipelines.lit);
      drawPlan(main, { plan, instanceGroup }, {
        filter: (b) => b.alphaMode !== "blend" && b.alphaMode !== "additive",
        pipeline: (b) => b.doubleSided ? pipelines.litDouble : pipelines.lit,
      });
    }
    main.end();
    passes++;

    let transparentView: GPUTextureView | null = null;
    const transparent = (b: typeof plan.batches[number]) =>
      b.alphaMode === "blend" || b.alphaMode === "additive";
    if (
      !wireframe &&
      (plan.batches.some(transparent) || this.particles?.batches.length)
    ) {
      const layer = this.ensureTransparency(targets);
      const pass = encoder.beginRenderPass({
        label: "transparency",
        colorAttachments: [{
          view: layer.color.createView(),
          resolveTarget: layer.resolveView,
          clearValue: [0, 0, 0, 0],
          loadOp: "clear",
          storeOp: "discard",
        }],
        depthStencilAttachment: { view: depthView, depthReadOnly: true },
      });
      const layers = [
        ...plan.batches.filter(transparent).map((batch) => ({
          depth: batch.depth,
          mesh: batch,
        })),
        ...(this.particles?.batches ?? []).map((batch) => ({
          depth: batch.depth,
          particle: batch,
        })),
      ].sort((a, b) => b.depth - a.depth);
      for (const layer of layers) {
        if ("particle" in layer) {
          this.particles!.draw(pass, layer.particle);
        } else {
          const b = layer.mesh;
          pass.setBindGroup(0, frameGroup);
          pass.setBindGroup(1, b.material);
          pass.setBindGroup(2, instanceGroup);
          pass.setPipeline(
            b.alphaMode === "additive"
              ? b.doubleSided ? pipelines.additiveDouble : pipelines.additive
              : b.doubleSided
              ? pipelines.blendDouble
              : pipelines.blend,
          );
          pass.setVertexBuffer(0, b.mesh.vertex);
          pass.setIndexBuffer(b.mesh.index, "uint32");
          pass.drawIndexed(b.mesh.indexCount, b.count, 0, 0, b.first);
        }
      }
      pass.end();
      transparentView = layer.resolveView;
      passes++;
    } else this.releaseTransparency();

    // Overlay layer: grid, fills and lines, depth-tested against the scene.
    const hasOverlay = !!extra.grid || extra.fillVertices > 0 ||
      lineCount > 0 || overlays.debug === "shadow-atlas";
    let overlayView: GPUTextureView | null = null;
    if (hasOverlay) {
      const layer = this.ensureOverlayTargets(targets);
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: layer.color.createView(),
          resolveTarget: layer.resolveView,
          clearValue: [0, 0, 0, 0],
          loadOp: "clear",
          storeOp: "discard",
        }],
        depthStencilAttachment: { view: depthView, depthReadOnly: true },
      });
      pass.setBindGroup(0, frameGroup);
      if (extra.grid) {
        pass.setPipeline(pipelines.grid);
        pass.setBindGroup(1, this.gridGroup);
        pass.draw(3);
      }
      if (extra.fillVertices) {
        pass.setPipeline(pipelines.fills);
        pass.setBindGroup(1, this.fillsGroup!);
        pass.draw(extra.fillVertices);
      }
      if (extra.testedLines) {
        pass.setPipeline(pipelines.lines);
        pass.setBindGroup(1, this.linesGroup!);
        pass.draw(6, extra.testedLines, 0, 0);
      }
      if (extra.overlayLines) {
        pass.setPipeline(pipelines.linesOverlay);
        pass.setBindGroup(1, this.linesGroup!);
        pass.draw(6, extra.overlayLines, 0, extra.testedLines);
      }
      for (const system of this.systems) system.drawOverlay?.(pass, context);
      pass.end();
      passes++;
      overlayView = layer.resolveView;
    }

    // Post: HDR to display-referred linear light.
    let sceneColor = targets.resolve.createView();
    if (
      environment.reflections > 0 && !wireframe && overlays.shading !== "unlit"
    ) {
      this.reflections ??= new ScreenReflections(this.core);
      sceneColor = this.reflections.encode(context, frameGroup, sceneColor);
      passes += 2;
    } else {
      this.reflections?.dispose();
      this.reflections = undefined;
    }
    const lateOverlay = temporal || scale !== 1;
    this.post.encode(encoder, {
      scene: sceneColor,
      overlay: lateOverlay ? null : overlayView,
      transparency: transparentView,
      environment,
      quality,
      bypass: overlays.shading === "unlit" || wireframe,
      background: flat
        ? [srgbToLinear(flat[0]), srgbToLinear(flat[1]), srgbToLinear(flat[2])]
        : null,
      frame: viewFrame,
      dt,
      still,
    });
    passes += this.post.stats.passes;
    let output = this.post.output;
    if (this.temporal) {
      this.temporal.encodeMotion(
        encoder,
        plan,
        this.neutralGroup,
        instanceGroup,
      );
      output = this.temporal.resolve(encoder, output, transparentView);
      passes += 2;
    }
    if (lateOverlay && overlayView) {
      device.queue.writeBuffer(this.finalBuffer, 56, new Float32Array([1]));
    }
    this.finalGroup = device.createBindGroup({
      layout: pipelines.finalLayout,
      entries: [
        { binding: 0, resource: output },
        { binding: 1, resource: targets.maskResolve.createView() },
        { binding: 2, resource: { buffer: this.finalBuffer } },
        { binding: 3, resource: this.core.dummies.blueNoise },
        {
          binding: 4,
          resource: lateOverlay && overlayView
            ? overlayView
            : this.core.dummies.transparent,
        },
      ],
    });

    // Selection mask, depth-tested against the main pass.
    if (flagged) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: targets.mask.createView(),
          resolveTarget: targets.maskResolve.createView(),
          clearValue: [0, 0, 0, 0],
          loadOp: "clear",
          storeOp: "discard",
        }],
        depthStencilAttachment: { view: depthView, depthReadOnly: true },
      });
      pass.setPipeline(pipelines.mask);
      pass.setBindGroup(0, frameGroup);
      drawPlan(pass, { plan, instanceGroup }, {
        filter: (b) => b.flagged,
        pipeline: (b) => b.doubleSided ? pipelines.maskDouble : pipelines.mask,
      });
      pass.end();
      passes++;
    }

    if (this.context) {
      encodeFinal(
        encoder,
        this.core,
        this.finalGroup!,
        this.context.getCurrentTexture().createView(),
      );
      passes++;
    }
    device.queue.submit([encoder.finish()]);
    assets.endFrame(frameNumber);
    this.stats = {
      lightmapSamples: this.lightmaps.samples,
      lightmapCharts: this.lightmaps.count,
      pendingWork: this.lightmaps.pending,
      reflectionProbes: this.lightmaps.probeCount,
      passes,
      environmentBakes: this.environmentLight.bakes,
      lights: frame.ordered.length,
      clusters: this.clusters.count,
      particles: this.particles?.count ?? 0,
      temporalFrames: this.temporal?.history.frames ?? 0,
      renderWidth: width,
      renderHeight: height,
    };

    this.picker.invalidate();
    this.last = {
      scene,
      camera,
      overlays,
      pickFrame: {
        width,
        height,
        frameGroup,
        instanceGroup,
        plan,
        invViewProj: frame.data.slice(
          FRAME.invViewProj,
          FRAME.invViewProj + 16,
        ),
      },
    };
  }

  /** Re-render the last frame once, e.g. after an asset finished loading. */
  private queueRedraw() {
    if (this.redrawQueued || !this.last || this.disposed) return;
    this.redrawQueued = true;
    queueMicrotask(() => {
      this.redrawQueued = false;
      if (this.last && !this.disposed) {
        this.render(this.last.scene, this.last.camera, this.last.overlays);
      }
    });
  }

  // Readback ------------------------------------------------------------------

  async pick(x: number, y: number): Promise<Pick | null> {
    const frame = this.last?.pickFrame;
    if (!frame || this.disposed || this.core.lost) return null;
    if (x < 0 || y < 0 || x >= this.cssWidth || y >= this.cssHeight) {
      return null;
    }
    const jitter = this.temporal?.jitter ?? [0, 0];
    const px = Math.max(
      0,
      Math.min(
        frame.width - 1,
        Math.floor((x * frame.width) / this.cssWidth + jitter[0]),
      ),
    );
    const py = Math.max(
      0,
      Math.min(
        frame.height - 1,
        Math.floor((y * frame.height) / this.cssHeight + jitter[1]),
      ),
    );
    return await this.picker.pick(frame, px, py);
  }

  async readPixels(): Promise<PixelData> {
    if (!this.targets || !this.finalGroup) {
      return {
        width: this.width,
        height: this.height,
        data: new Uint8Array(this.width * this.height * 4),
      };
    }
    return await readFrame(
      this.core,
      this.finalGroup,
      this.width,
      this.height,
    );
  }

  async capture(): Promise<Blob> {
    const { width, height, data } = await this.readPixels();
    return new Blob([await encodePng(width, height, data) as BlobPart], {
      type: "image/png",
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.picker.dispose();
    this.releaseTargets();
    this.post.dispose();
    this.temporal?.dispose();
    this.lightmaps.dispose();
    this.reflections?.dispose();
    this.particles?.dispose();
    for (const system of this.systems) system.dispose();
    for (
      const b of [
        this.frameBuffer,
        this.lightBuffer,
        this.shadowMatrixBuffer,
        this.gridBuffer,
        this.finalBuffer,
      ]
    ) b.destroy();
    this.instances.destroy();
    this.joints.destroy();
    this.morphs.destroy();
    this.lines.destroy();
    this.fills.destroy();
    this.context?.unconfigure();
  }
}

const viewIds = new WeakMap<object, number>();
let nextViewId = 1;
function viewId(view: GPUTextureView | GPUBuffer): number {
  let id = viewIds.get(view);
  if (!id) viewIds.set(view, id = nextViewId++);
  return id;
}
