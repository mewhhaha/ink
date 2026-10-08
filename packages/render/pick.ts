/**
 * Picking by id pass: the scene is drawn again into an entity/face id target,
 * a normal target and a depth buffer, and the pixel under the cursor is read
 * back. The world position is reconstructed from the depth.
 */
import { type Mat4, mat4, type Vec3 } from "@ink/geometry";
import type { Core } from "./core.ts";
import {
  BufferUsage,
  DEPTH_FORMAT,
  MAP_READ,
  texture2d,
  TextureUsage,
} from "./gpu.ts";
import type { Plan } from "./plan.ts";
import type { Pick } from "./types.ts";

export interface PickFrame {
  width: number;
  height: number;
  frameGroup: GPUBindGroup;
  instanceGroup: GPUBindGroup;
  plan: Plan;
  invViewProj: Mat4;
}

export class Picker {
  private targets?: {
    width: number;
    height: number;
    ids: GPUTexture;
    normals: GPUTexture;
    depth: GPUTexture;
    depthColor: GPUTexture;
  };
  /** Frame whose id pass is currently in the targets. */
  private drawn: PickFrame | null = null;

  constructor(private core: Core) {}

  /** A new frame was rendered; the id pass is out of date. */
  invalidate() {
    this.drawn = null;
  }

  private ensure(width: number, height: number) {
    const t = this.targets;
    if (t && t.width === width && t.height === height) return t;
    this.dispose();
    const d = this.core.device;
    const usage = TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC;
    this.targets = {
      width,
      height,
      ids: texture2d(d, "pick-ids", width, height, "rg32uint", usage),
      normals: texture2d(d, "pick-normals", width, height, "rgba8unorm", usage),
      depth: texture2d(
        d,
        "pick-depth-buffer",
        width,
        height,
        DEPTH_FORMAT,
        TextureUsage.RENDER_ATTACHMENT,
      ),
      depthColor: texture2d(d, "pick-depth", width, height, "r32float", usage),
    };
    this.drawn = null;
    return this.targets;
  }

  private draw(frame: PickFrame) {
    const { device, pipelines } = this.core;
    const t = this.ensure(frame.width, frame.height);
    const encoder = device.createCommandEncoder({ label: "pick" });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: t.ids.createView(),
          clearValue: [0, 0, 0, 0],
          loadOp: "clear",
          storeOp: "store",
        },
        {
          view: t.normals.createView(),
          clearValue: [0.5, 0.5, 1, 1],
          loadOp: "clear",
          storeOp: "store",
        },
        {
          view: t.depthColor.createView(),
          clearValue: [1, 0, 0, 0],
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: t.depth.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setPipeline(pipelines.pick);
    pass.setBindGroup(0, frame.frameGroup);
    pass.setBindGroup(2, frame.instanceGroup);
    for (const batch of frame.plan.batches) {
      pass.setPipeline(
        batch.doubleSided ? pipelines.pickDouble : pipelines.pick,
      );
      pass.setBindGroup(1, batch.material);
      pass.setVertexBuffer(0, batch.mesh.vertex);
      pass.setIndexBuffer(batch.mesh.index, "uint32");
      pass.drawIndexed(batch.mesh.indexCount, batch.count, 0, 0, batch.first);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
    this.drawn = frame;
  }

  /** Read the pixel at device coordinates (px, py). */
  async pick(frame: PickFrame, px: number, py: number): Promise<Pick | null> {
    if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) {
      return null;
    }
    if (this.drawn !== frame) this.draw(frame);
    const t = this.targets!;
    const { device } = this.core;
    const staging = device.createBuffer({
      label: "pick-readback",
      size: 768,
      usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
    });
    const encoder = device.createCommandEncoder({ label: "pick-read" });
    const origin = [px, py];
    const copy = (texture: GPUTexture, offset: number) =>
      encoder.copyTextureToBuffer(
        { texture, origin },
        { buffer: staging, offset, bytesPerRow: 256 },
        [1, 1],
      );
    copy(t.ids, 0);
    copy(t.normals, 256);
    copy(t.depthColor, 512);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(MAP_READ);
    const bytes = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    const ids = new Uint32Array(bytes, 0, 2);
    const normal = new Uint8Array(bytes, 256, 4);
    const depth = new Float32Array(bytes, 512, 1)[0];
    const entity = ids[0];
    if (entity === 0) return null;
    const ndc: Vec3 = [
      ((px + 0.5) / frame.width) * 2 - 1,
      1 - ((py + 0.5) / frame.height) * 2,
      depth,
    ];
    const n: Vec3 = [
      (normal[0] / 255) * 2 - 1,
      (normal[1] / 255) * 2 - 1,
      (normal[2] / 255) * 2 - 1,
    ];
    const length = Math.hypot(n[0], n[1], n[2]) || 1;
    return {
      entity,
      face: ids[1] === 0 ? -1 : ids[1] - 1,
      point: mat4.transformPoint(frame.invViewProj, ndc),
      normal: [n[0] / length, n[1] / length, n[2] / length],
      depth,
    };
  }

  dispose() {
    this.targets?.ids.destroy();
    this.targets?.normals.destroy();
    this.targets?.depth.destroy();
    this.targets?.depthColor.destroy();
    this.targets = undefined;
    this.drawn = null;
  }
}
