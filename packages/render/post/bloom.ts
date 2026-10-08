/** Bloom: the mip chain behind `shaders/post_bloom.ts`. Level 0 is half the
 * view size; `output` is the finished level-0 image. */
import type { Core } from "../core.ts";
import { COLOR_FORMAT, TextureUsage } from "../gpu.ts";

const MAX_LEVELS = 6;
/** Weight of each upsampled level against the one it is added to: the result
 * is a weighted average (1-c, c(1-c), c²(1-c)...), so wide glow keeps a fair
 * share without the image getting brighter. */
const UP_BLEND = 0.6;

export class Bloom {
  readonly levels: number;
  private texture: GPUTexture;
  private views: GPUTextureView[] = [];
  private down: GPUBindGroup[] = [];
  private up: GPUBindGroup[] = [];

  constructor(
    private core: Core,
    width: number,
    height: number,
    hdr: GPUTextureView,
  ) {
    const w = Math.max(1, width >> 1), h = Math.max(1, height >> 1);
    this.levels = Math.max(
      1,
      Math.min(MAX_LEVELS, Math.floor(Math.log2(Math.min(w, h)))),
    );
    const { device, post } = core;
    this.texture = device.createTexture({
      label: "bloom",
      size: [w, h],
      format: COLOR_FORMAT,
      mipLevelCount: this.levels,
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.RENDER_ATTACHMENT,
    });
    for (let i = 0; i < this.levels; i++) {
      this.views.push(
        this.texture.createView({ baseMipLevel: i, mipLevelCount: 1 }),
      );
    }
    const group = (view: GPUTextureView) =>
      device.createBindGroup({
        layout: post.bloomLayout,
        entries: [
          { binding: 0, resource: view },
          { binding: 1, resource: post.sampler },
        ],
      });
    for (let i = 0; i < this.levels; i++) {
      this.down.push(group(i === 0 ? hdr : this.views[i - 1]));
    }
    for (let i = 1; i < this.levels; i++) this.up.push(group(this.views[i]));
  }

  /** The finished bloom image (half resolution). */
  get output(): GPUTextureView {
    return this.views[0];
  }

  encode(encoder: GPUCommandEncoder) {
    const { post } = this.core;
    for (let i = 0; i < this.levels; i++) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.views[i],
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setPipeline(i === 0 ? post.bloomDownKaris : post.bloomDown);
      pass.setBindGroup(0, this.down[i]);
      pass.draw(3);
      pass.end();
    }
    // Upsample from the smallest level, blending into the next larger one.
    for (let i = this.levels - 1; i >= 1; i--) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.views[i - 1],
          loadOp: "load",
          storeOp: "store",
        }],
      });
      pass.setPipeline(post.bloomUp);
      pass.setBlendConstant([UP_BLEND, UP_BLEND, UP_BLEND, UP_BLEND]);
      pass.setBindGroup(0, this.up[i - 1]);
      pass.draw(3);
      pass.end();
    }
  }

  destroy() {
    this.texture.destroy();
  }
}
