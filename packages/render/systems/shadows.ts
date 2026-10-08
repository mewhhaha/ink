/**
 * Sun shadow system: cascaded shadow maps for up to four directional lights
 * with `shadows`. The WGSL side is `sunShadow` in shaders/shadows.ts.
 *
 * The view's depth range (camera near to `environment.shadow_distance`,
 * tightened to the scene's extent) is cut into 4 slices (2 at low quality) by
 * the practical split scheme (a blend of logarithmic and uniform). Each slice
 * is covered by an orthographic map fitted to the slice's bounding sphere:
 * a sphere does not change size when the camera turns, and the map's origin
 * is snapped to whole texels, so shadow edges do not swim or shimmer. Casters
 * between the slice and the light are kept by extending the near plane.
 * Cascades whose content did not change (static scene, camera moved less than
 * a texel) are not re-rendered.
 */
import {
  type Aabb,
  aabbIsEmpty,
  type Mat4,
  mat4,
  type Vec3,
} from "@ink/geometry";
import {
  DEPTH_FORMAT,
  INSTANCE_FLOATS,
  OVERLAY_FORMAT,
  SAMPLES,
  TextureUsage,
} from "../gpu.ts";
import { shadowDebugShader } from "../shaders/shadows.ts";
import {
  LIGHT_FLOATS,
  MAX_CASCADES,
  MAX_SUN_SHADOWS,
} from "../shaders/frame_layout.ts";
import { instanceInClip } from "../culling.ts";
import { drawPlan } from "../systems.ts";
import type {
  FrameContext,
  PrepareContext,
  RenderSystem,
  SystemBindings,
} from "../systems.ts";
import type { Camera } from "../types.ts";
import {
  casterSignature,
  hashFloats,
  mix,
  ShadowPasses,
} from "./shadow_common.ts";

export const SHADOW_SIZE_HIGH = 2048;
export const SHADOW_SIZE_LOW = 1024;
export const CASCADES_HIGH = 4;
export const CASCADES_LOW = 2;
/** Weight of the logarithmic split in the practical scheme. */
export const SPLIT_LAMBDA = 0.75;
/** The map covers its slice's sphere this much larger, so a cascade can be
 * blended into the next one without running out of map. */
const FIT_MARGIN = 1.2;

/** Far view distance of each of `count` slices between `near` and `far`. */
export function cascadeSplits(
  near: number,
  far: number,
  count: number,
  orthographic = false,
  lambda = SPLIT_LAMBDA,
): number[] {
  const out: number[] = [];
  for (let i = 1; i <= count; i++) {
    const p = i / count;
    const uniform = near + (far - near) * p;
    const log = near * Math.pow(far / near, p);
    out.push(orthographic ? uniform : lambda * log + (1 - lambda) * uniform);
  }
  out[count - 1] = far;
  return out;
}

/** Round up to a step of 2^(1/16): keeps values stable under small changes. */
const quantizeUp = (x: number) =>
  Math.pow(2, Math.ceil(Math.log2(Math.max(x, 1e-4)) * 16) / 16);

export interface CascadePlan {
  /** World to cascade clip space, one per cascade. */
  matrices: Mat4[];
  /** Far view distance of each cascade. */
  splits: number[];
  /** Half extent of each map in world units. */
  radii: number[];
  /** World size of one shadow texel, per cascade. */
  texels: number[];
}

export interface CascadeInput {
  camera: Camera;
  /** Direction the light travels. */
  direction: Vec3;
  casterBounds: Aabb;
  /** Bounds of all geometry; limits the far end of the last cascade. */
  sceneBounds: Aabb | null;
  distance: number;
  count: number;
  size: number;
}

const corners = (b: Aabb): Vec3[] => {
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]]) {
    for (const y of [b.min[1], b.max[1]]) {
      for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
    }
  }
  return out;
};

/** Fit `count` cascades to the camera's frustum; see the file comment. */
export function planCascades(input: CascadeInput): CascadePlan {
  const { camera, direction, casterBounds, count, size } = input;
  const p = camera.projection;
  const ortho = camera.orthographic;
  const near = Math.max(camera.near, 1e-3);
  let far = Math.min(camera.far, input.distance);
  if (input.sceneBounds && !aabbIsEmpty(input.sceneBounds)) {
    // Nothing is visible beyond the scene's far corner.
    let deepest = 0;
    for (const c of corners(input.sceneBounds)) {
      deepest = Math.max(deepest, -mat4.transformPoint(camera.view, c)[2]);
    }
    far = Math.min(far, quantizeUp(deepest + 1));
  }
  far = Math.max(far, near * 1.5);
  const splits = cascadeSplits(near, far, count, ortho);

  // Frustum half extents per unit depth (perspective) or in total (ortho).
  const hx = 1 / p[0], hy = 1 / p[5];
  const ox = ortho ? -p[12] / p[0] : 0, oy = ortho ? -p[13] / p[5] : 0;
  const worldFromView = mat4.invert(camera.view);
  const up: Vec3 = Math.abs(direction[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  const rotation = mat4.lookAt([0, 0, 0], direction, up);
  const casterZ = Math.max(
    ...corners(casterBounds).map((c) => mat4.transformPoint(rotation, c)[2]),
  );

  const matrices: Mat4[] = [];
  const radii: number[] = [];
  const texels: number[] = [];
  let a = near;
  for (const b of splits) {
    // Bounding sphere of the slice [a, b] in view space.
    let zc: number, radius: number;
    if (ortho) {
      zc = (a + b) / 2;
      radius = Math.hypot(hx, hy, (b - a) / 2);
    } else {
      const k = hx * hx + hy * hy;
      zc = Math.min(((a + b) * (1 + k)) / 2, b);
      radius = Math.hypot(b - zc, b * Math.sqrt(k));
    }
    const center = mat4.transformPoint(worldFromView, [ox, oy, -zc]);
    const half = quantizeUp(radius * FIT_MARGIN);
    const texel = (2 * half) / size;
    const c = mat4.transformPoint(rotation, center);
    const cx = Math.round(c[0] / texel) * texel;
    const cy = Math.round(c[1] / texel) * texel;
    // Light-space z is negative along the light's direction: the nearest
    // plane is the closest of the sphere's front and the casters' front.
    // Rounded outwards to a coarse step so the matrix (and the cache key)
    // only changes when the map really has to move.
    const step = half / 8;
    const nearPlane =
      Math.floor((Math.min(-(c[2] + half), -casterZ) - 0.5) / step) * step;
    const farPlane = Math.ceil((-c[2] + half + 0.5) / step) * step;
    const projection = mat4.orthographic(
      cx - half,
      cx + half,
      cy - half,
      cy + half,
      nearPlane,
      farPlane,
    );
    matrices.push(mat4.multiply(projection, rotation));
    radii.push(half);
    texels.push(texel);
    a = b;
  }
  return { matrices, splits, radii, texels };
}

const debugPipelines = new WeakMap<GPUDevice, GPURenderPipeline>();

export class SunShadowSystem implements RenderSystem {
  readonly name = "sun-shadow";
  private texture?: GPUTexture;
  private arrayView?: GPUTextureView;
  private layerViews: GPUTextureView[] = [];
  private passes?: ShadowPasses;
  private size = 0;
  private count = 0;
  private active = false;
  private matrices: Mat4[] = [];
  /** Signature of what each layer currently holds (0: nothing). */
  private signatures: number[] = [];
  /** The last plan, for tests and tools. */
  plan?: CascadePlan;

  prepare(ctx: PrepareContext) {
    this.active = false;
    const modes = { cascades: 1, ao: 2, "shadow-atlas": 3 };
    ctx.write("debug", [ctx.overlays.debug ? modes[ctx.overlays.debug] : 0]);
    const { sun, casterBounds } = ctx.frame;
    if (
      !sun || aabbIsEmpty(casterBounds) ||
      ctx.overlays.shading === "wireframe" || ctx.overlays.shading === "unlit"
    ) return;
    const high = ctx.quality === "high";
    const size = high ? SHADOW_SIZE_HIGH : SHADOW_SIZE_LOW;
    const count = Math.min(high ? CASCADES_HIGH : CASCADES_LOW, MAX_CASCADES);
    const suns = ctx.frame.ordered.map((light, index) => ({ light, index }))
      .filter(({ light }) => light.kind === "directional" && light.shadows)
      .slice(0, MAX_SUN_SHADOWS);
    this.ensure(ctx, size, count * suns.length);
    this.matrices = [];
    for (const { light, index } of suns) {
      const plan = planCascades({
        camera: ctx.camera,
        direction: light.direction,
        casterBounds,
        sceneBounds: ctx.scene.bounds,
        distance: ctx.environment.shadowDistance,
        count,
        size,
      });
      const first = this.matrices.length;
      ctx.frame.lights[index * LIGHT_FLOATS + 14] = first;
      this.matrices.push(...plan.matrices);
      if (first === 0) this.plan = plan;
      plan.matrices.forEach((m, i) =>
        ctx.write("cascades", m, (first + i) * 16)
      );
    }
    const plan = this.plan!;
    ctx.write("cascadeSplits", [
      ...plan.splits,
      ...Array(MAX_CASCADES - count).fill(plan.splits[count - 1]),
    ]);
    ctx.write("shadow", [size, count, high ? 32 : 12, high ? 12 : 6]);
    ctx.write("params", [1], 2);
    ctx.write("systems", [1], 0);
    this.active = true;
  }

  bindings(): SystemBindings {
    return this.active ? { sunShadow: this.arrayView } : {};
  }

  encode(ctx: FrameContext): number {
    if (!this.active) return 0;
    const casters = casterSignature(ctx.plan);
    let rendered = 0;
    for (let i = 0; i < this.count; i++) {
      const matrix = this.matrices[i];
      const signature = mix(hashFloats(casters, matrix), this.size) || 1;
      if (this.signatures[i] === signature) continue;
      this.signatures[i] = signature;
      this.passes!.set(i, matrix as Float32Array);
      const pass = this.passes!.begin(ctx.encoder, this.layerViews[i], i);
      drawPlan(pass, ctx, {
        filter: (b) => b.castsShadows,
        instance: (b, index) =>
          instanceInClip(
            b.mesh.bounds,
            matrix,
            ctx.plan.data.subarray(
              index * INSTANCE_FLOATS,
              index * INSTANCE_FLOATS + 16,
            ),
          ),
        material: ctx.core.assets.defaultMaterial,
      });
      pass.end();
      rendered++;
    }
    return rendered;
  }

  /** Overlays.debug = "shadow-atlas": thumbnails of the shadow maps. */
  drawOverlay(pass: GPURenderPassEncoder, ctx: FrameContext) {
    if (ctx.overlays.debug !== "shadow-atlas") return;
    const { device, pipelines } = ctx.core;
    let pipeline = debugPipelines.get(device);
    if (!pipeline) {
      const module = device.createShaderModule({
        label: "shadow-debug",
        code: shadowDebugShader,
      });
      pipeline = device.createRenderPipeline({
        label: "shadow-debug",
        layout: device.createPipelineLayout({
          bindGroupLayouts: [pipelines.frameLayout],
        }),
        vertex: { module, entryPoint: "vs" },
        fragment: {
          module,
          entryPoint: "fs",
          targets: [{ format: OVERLAY_FORMAT }],
        },
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: false,
          depthCompare: "always",
        },
        multisample: { count: SAMPLES },
      });
      debugPipelines.set(device, pipeline);
    }
    pass.setPipeline(pipeline);
    pass.draw(3);
  }

  private ensure(ctx: PrepareContext, size: number, count: number) {
    if (this.texture && this.size === size && this.count === count) return;
    this.texture?.destroy();
    this.size = size;
    this.count = count;
    this.signatures = [];
    this.passes ??= new ShadowPasses(ctx.core, MAX_CASCADES * MAX_SUN_SHADOWS);
    this.texture = ctx.core.device.createTexture({
      label: "sun-shadow",
      size: [size, size, count],
      format: DEPTH_FORMAT,
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
    });
    this.arrayView = this.texture.createView({ dimension: "2d-array" });
    this.layerViews = Array.from(
      { length: count },
      (_, i) =>
        this.texture!.createView({
          dimension: "2d",
          baseArrayLayer: i,
          arrayLayerCount: 1,
        }),
    );
  }

  dispose() {
    this.texture?.destroy();
    this.passes?.dispose();
  }
}
