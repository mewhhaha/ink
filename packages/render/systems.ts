/**
 * Render systems: pluggable parts of a frame that own GPU resources shaders
 * read through the frame bind group (group 0). A view holds one of each slot
 * (sun/local shadows, ambient occlusion, environment lighting) and, every
 * frame, calls for each system in order:
 *
 *   prepare(ctx)   CPU side, before the frame uniform is uploaded: write the
 *                  system's fields into ctx.frame.data / ctx.frame.lights
 *   bindings()     the texture views to expose; unset slots keep dummies
 *   encode(ctx)    record GPU work (shadow passes, AO, probe filtering) into
 *                  ctx.encoder before the main pass; returns the pass count
 *   drawOverlay    optional: draw into the overlay pass (debug insets)
 *
 * See "Extension points" in README.md for the binding table and the WGSL
 * hooks that consume these resources.
 */
import type { Aabb } from "@ink/geometry";
import type { Core } from "./core.ts";
import type { FrameData } from "./frame.ts";
import type { FRAME } from "./shaders/frame_layout.ts";
import type { Plan } from "./plan.ts";
import type {
  Camera,
  Environment,
  Overlays,
  Quality,
  RenderScene,
} from "./types.ts";

/** Texture views a system contributes to the frame group. */
export interface SystemBindings {
  probeCubes?: GPUTextureView;
  probes?: GPUBuffer;
  lightmap?: GPUTextureView;
  lightmapCharts?: GPUBuffer;
  /** binding 14: packed cluster light counts and indices. */
  clusters?: GPUBuffer;
  /** binding 1: texture_depth_2d_array (one layer per cascade). */
  sunShadow?: GPUTextureView;
  /** binding 3: texture_depth_2d, the spot shadow atlas. */
  spotShadow?: GPUTextureView;
  /** binding 4: texture_depth_cube_array, point shadows. */
  pointShadow?: GPUTextureView;
  /** binding 13: the point shadow cubes as a texture_depth_2d_array (6 layers
   * per cube) for blocker search. */
  pointFaces?: GPUTextureView;
  /** binding 5: r8unorm (or any filterable float) ambient occlusion, 1 = open. */
  ao?: GPUTextureView;
  /** binding 7: texture_cube, the environment (filterable float format). */
  environment?: GPUTextureView;
  /** binding 8: texture_cube with mips, GGX-prefiltered specular. */
  specular?: GPUTextureView;
  /** binding 9: texture_2d, split-sum BRDF lookup (x scale, y bias). */
  brdfLut?: GPUTextureView;
}

export interface PrepareContext {
  /** Jittered projection for screen-space passes; camera remains unjittered. */
  rasterCamera?: Camera;
  core: Core;
  scene: RenderScene;
  camera: Camera;
  overlays: Overlays;
  /** Scene environment with the view's overrides applied. */
  environment: Environment;
  quality: Quality;
  /** The frame being built. Systems write their own fields (offsets in
   * FRAME) and per-light fields (`frame.lights`, LIGHT_FLOATS each). */
  frame: FrameData;
  /** Write named frame uniform fields; `at` offsets into the field. */
  write(
    field: keyof typeof FRAME,
    values: ArrayLike<number>,
    at?: number,
  ): void;
  /** Storage buffer behind binding 12 (`shadowMatrices`), room for
   * MAX_SHADOW_MATRICES mat4x4f. Upload with queue.writeBuffer. */
  shadowMatrices: GPUBuffer;
  /** Ordered lights, shared by shading and the cluster compute pass. */
  lightBuffer: GPUBuffer;
  casterBounds: Aabb;
  width: number;
  height: number;
}

export interface FrameContext extends PrepareContext {
  encoder: GPUCommandEncoder;
  plan: Plan;
  /** Frame group with every extension slot bound to a dummy: use it as group
   * 0 in passes that render into a system's own textures. */
  neutralGroup: GPUBindGroup;
  /** Group 2 of mesh pipelines (the instance buffer). */
  instanceGroup: GPUBindGroup;
  /** The frame uniform buffer (COPY_DST): a system whose data comes from the
   * GPU can copy it into its fields (`FRAME.<field> * 4`) every frame. */
  frameBuffer: GPUBuffer;
}

export interface RenderSystem {
  readonly name: string;
  prepare?(ctx: PrepareContext): void;
  bindings(): SystemBindings;
  /** Returns the number of render passes it recorded (for `View.stats`). */
  encode(ctx: FrameContext): number | void;
  /** Draw into the overlay pass (frame group bound at 0), e.g. debug insets. */
  drawOverlay?(pass: GPURenderPassEncoder, ctx: FrameContext): void;
  dispose(): void;
}

/** Draw the plan's batches with the bound mesh pipeline: instance group at 2,
 * each batch's material at 1 (or `material` for all, e.g. depth-only passes). */
export function drawPlan(
  pass: GPURenderPassEncoder,
  ctx: Pick<FrameContext, "plan" | "instanceGroup">,
  options: {
    filter?: (batch: Plan["batches"][number]) => boolean;
    instance?: (batch: Plan["batches"][number], index: number) => boolean;
    material?: GPUBindGroup;
    pipeline?: (batch: Plan["batches"][number]) => GPURenderPipeline;
  } = {},
) {
  pass.setBindGroup(2, ctx.instanceGroup);
  for (const b of ctx.plan.batches) {
    if (options.filter && !options.filter(b)) continue;
    if (options.pipeline) pass.setPipeline(options.pipeline(b));
    pass.setBindGroup(1, options.material ?? b.material);
    pass.setVertexBuffer(0, b.mesh.vertex);
    pass.setIndexBuffer(b.mesh.index, "uint32");
    if (!options.instance) {
      pass.drawIndexed(b.mesh.indexCount, b.count, 0, 0, b.first);
    } else {
      let first = -1;
      for (let i = b.first; i <= b.first + b.count; i++) {
        const visible = i < b.first + b.count && options.instance(b, i);
        if (visible && first < 0) first = i;
        if (!visible && first >= 0) {
          pass.drawIndexed(b.mesh.indexCount, i - first, 0, 0, first);
          first = -1;
        }
      }
    }
  }
}
