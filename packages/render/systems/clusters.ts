import { BufferUsage, GrowBuffer } from "../gpu.ts";
import {
  CLUSTER_CAPACITY,
  CLUSTER_MAX_AXIS,
  CLUSTER_SLICES,
  CLUSTER_TILE,
} from "../shaders/frame_layout.ts";
import { clustersWgsl } from "../shaders/clusters.ts";
import type {
  FrameContext,
  PrepareContext,
  RenderSystem,
  SystemBindings,
} from "../systems.ts";

const pipelines = new WeakMap<GPUDevice, GPUComputePipeline>();
function pipelineFor(device: GPUDevice): GPUComputePipeline {
  let pipeline = pipelines.get(device);
  if (!pipeline) {
    pipeline = device.createComputePipeline({
      label: "cluster-light-culling",
      layout: "auto",
      compute: {
        module: device.createShaderModule({
          label: "clusters",
          code: clustersWgsl,
        }),
        entryPoint: "cull",
      },
    });
    pipelines.set(device, pipeline);
  }
  return pipeline;
}

/** Per-view light lists. Geometry and every shadow system keep stable light ids. */
export class ClusteredLightSystem implements RenderSystem {
  readonly name = "clustered-lights";
  count = 0;
  #buffer?: GrowBuffer;
  #group?: GPUBindGroup;

  prepare(ctx: PrepareContext) {
    this.count = 0;
    const enabled = ctx.overlays.clustered !== false &&
      ctx.overlays.shading !== "unlit" &&
      ctx.overlays.shading !== "wireframe" &&
      ctx.frame.ordered.length > 8;
    if (!enabled) {
      this.dispose();
      return;
    }
    const x = Math.min(
      CLUSTER_MAX_AXIS,
      Math.max(1, Math.ceil(ctx.width / CLUSTER_TILE)),
    );
    const y = Math.min(
      CLUSTER_MAX_AXIS,
      Math.max(1, Math.ceil(ctx.height / CLUSTER_TILE)),
    );
    this.count = x * y * CLUSTER_SLICES;
    ctx.write("clusterGrid", [x, y, CLUSTER_SLICES, 1]);
    this.#buffer ??= new GrowBuffer(
      ctx.core.device,
      BufferUsage.STORAGE | BufferUsage.COPY_SRC,
      "light-clusters",
    );
    if (this.#buffer.reserve(this.count * (CLUSTER_CAPACITY + 1) * 4)) {
      this.#group = undefined;
    }
  }

  bindings(): SystemBindings {
    return { clusters: this.#buffer?.buffer };
  }

  encode(ctx: FrameContext): number {
    if (!this.count) return 0;
    const pipeline = pipelineFor(ctx.core.device);
    this.#group ??= ctx.core.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ctx.frameBuffer } },
        { binding: 1, resource: { buffer: ctx.lightBuffer } },
        { binding: 2, resource: { buffer: this.#buffer!.buffer } },
      ],
    });
    const pass = ctx.encoder.beginComputePass({
      label: "cluster-light-culling",
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.#group);
    pass.dispatchWorkgroups(Math.ceil(this.count / 64));
    pass.end();
    return 1;
  }

  dispose() {
    this.#buffer?.destroy();
    this.#buffer = undefined;
    this.#group = undefined;
    this.count = 0;
  }
}
