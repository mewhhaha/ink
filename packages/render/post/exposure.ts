/** Auto exposure: reduces the HDR image to its average log luminance and
 * adapts a stored exposure multiplier over time. The adapted value lives in a
 * pair of 1x1 textures that persist for the life of the view. */
import type { Core } from "../core.ts";
import { BufferUsage, TextureUsage } from "../gpu.ts";

/** Mid grey the image is steered towards. */
const KEY = 0.18;
const MIN_MULTIPLIER = 1 / 64;
const MAX_MULTIPLIER = 64;
/** Adaptation speeds (1/s): to a darker target exposure vs a brighter one. */
const SPEED_BRIGHTER = 3;
const SPEED_DARKER = 1.5;

export class AutoExposure {
  private history: GPUTexture[] = [];
  private historyViews: GPUTextureView[] = [];
  private current = 0;
  private valid = false;
  private uniform: GPUBuffer;
  private chain: GPUTexture[] = [];
  private lumaGroups: GPUBindGroup[] = [];

  constructor(private core: Core) {
    const { device } = core;
    for (let i = 0; i < 2; i++) {
      const t = device.createTexture({
        label: `exposure-${i}`,
        size: [1, 1],
        format: "r32float",
        usage: TextureUsage.TEXTURE_BINDING | TextureUsage.RENDER_ATTACHMENT,
      });
      this.history.push(t);
      this.historyViews.push(t.createView());
    }
    this.uniform = device.createBuffer({
      label: "exposure",
      size: 32,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
  }

  /** Rebuild the reduction chain for a new HDR image. */
  resize(width: number, height: number, hdr: GPUTextureView) {
    this.releaseChain();
    const { device, post } = this.core;
    let w = width, h = height;
    let source = hdr;
    const stages: [number, number][] = [];
    do {
      w = Math.max(1, Math.ceil(w / 8));
      h = Math.max(1, Math.ceil(h / 8));
      stages.push([w, h]);
    } while (w > 1 || h > 1);
    for (const [sw, sh] of stages) {
      this.lumaGroups.push(
        device.createBindGroup({
          layout: post.reduceLayout,
          entries: [{ binding: 0, resource: source }],
        }),
      );
      const t = device.createTexture({
        label: "exposure-reduce",
        size: [sw, sh],
        format: "rg32float",
        usage: TextureUsage.TEXTURE_BINDING | TextureUsage.RENDER_ATTACHMENT,
      });
      this.chain.push(t);
      source = t.createView();
    }
  }

  /** Render passes `encode` records: the reduction chain plus adaptation. */
  get passCount(): number {
    return this.chain.length + 1;
  }

  /** The adapted exposure multiplier (1x1 r32float) after `encode`. */
  get output(): GPUTextureView {
    return this.historyViews[this.current];
  }

  /** Forget the adapted value: the next frame jumps straight to its target. */
  reset() {
    this.valid = false;
  }

  encode(encoder: GPUCommandEncoder, dt: number) {
    const { device, post } = this.core;
    for (let i = 0; i < this.chain.length; i++) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.chain[i].createView(),
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setPipeline(i === 0 ? post.luma : post.reduce);
      pass.setBindGroup(0, this.lumaGroups[i]);
      pass.draw(3);
      pass.end();
    }
    const next = 1 - this.current;
    device.queue.writeBuffer(
      this.uniform,
      0,
      new Float32Array([
        dt,
        SPEED_BRIGHTER,
        SPEED_DARKER,
        this.valid ? 0 : 1,
        KEY,
        MIN_MULTIPLIER,
        MAX_MULTIPLIER,
        0,
      ]),
    );
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.historyViews[next],
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(post.adapt);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: post.adaptLayout,
        entries: [
          {
            binding: 0,
            resource: this.chain[this.chain.length - 1].createView(),
          },
          { binding: 1, resource: this.historyViews[this.current] },
          { binding: 2, resource: { buffer: this.uniform } },
        ],
      }),
    );
    pass.draw(3);
    pass.end();
    this.current = next;
    this.valid = true;
  }

  private releaseChain() {
    for (const t of this.chain) t.destroy();
    this.chain = [];
    this.lumaGroups = [];
  }

  destroy() {
    this.releaseChain();
    for (const t of this.history) t.destroy();
    this.uniform.destroy();
  }
}
