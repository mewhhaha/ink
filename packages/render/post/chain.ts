/**
 * The post chain of one view: the resolved scene radiance goes in, the
 * display-referred linear image (overlay layer included) comes out.
 *
 *   decode   undo the tonemap-weighted resolve (only when a later stage
 *            needs the plain HDR image)
 *   exposure average luminance reduction + adaptation (auto exposure, high)
 *   bloom    13-tap downsample / tent upsample chain (high)
 *   tonemap  bloom mix, exposure, grading, tonemapper, vignette, grain, flat
 *            background and the overlay layer in one pass
 *
 * The final pass (capture.ts) then draws the selection outline and encodes
 * sRGB. Low quality runs only the tonemap pass. Bypassed frames (unlit,
 * wireframe) skip exposure, bloom and all grading.
 */
import { TONEMAP_INDEX } from "../environment.ts";
import type { Core } from "../core.ts";
import { BufferUsage, COLOR_FORMAT, TextureUsage } from "../gpu.ts";
import type { Environment, Quality } from "../types.ts";
import { Bloom } from "./bloom.ts";
import { AutoExposure } from "./exposure.ts";

export interface PostInput {
  /** Resolved scene colour, tonemap-weighted (see shaders/hdr.ts). */
  scene: GPUTextureView;
  /** Premultiplied overlay layer, or null when nothing was drawn. */
  overlay: GPUTextureView | null;
  /** Premultiplied linear HDR translucency over the opaque scene. */
  transparency?: GPUTextureView | null;
  environment: Environment;
  quality: Quality;
  /** Unlit / wireframe: show colours as authored. */
  bypass: boolean;
  /** Linear colour replacing pixels the scene did not cover. */
  background: [number, number, number] | null;
  frame: number;
  /** Seconds since the previous frame of this view. */
  dt: number;
  /** No temporal state: exposure jumps to its target this frame. */
  still?: boolean;
}

export interface PostStats {
  /** Render passes the chain encoded in the last frame. */
  passes: number;
}

export class PostChain {
  private width = 0;
  private height = 0;
  private hdr?: GPUTexture;
  private hdrView?: GPUTextureView;
  private ldr?: GPUTexture;
  private ldrView?: GPUTextureView;
  private bloom?: Bloom;
  private exposure?: AutoExposure;
  private uniform: GPUBuffer;
  stats: PostStats = { passes: 0 };

  constructor(private core: Core) {
    this.uniform = core.device.createBuffer({
      label: "post",
      size: 96,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
  }

  /** The display-referred linear image of the last frame. */
  get output(): GPUTextureView {
    return this.ldrView!;
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height && this.ldr) return;
    this.width = width;
    this.height = height;
    this.hdr?.destroy();
    this.hdr = undefined;
    this.hdrView = undefined;
    this.ldr?.destroy();
    this.bloom?.destroy();
    this.bloom = undefined;
    this.exposure?.destroy();
    this.exposure = undefined;
    const device = this.core.device;
    const usage = TextureUsage.TEXTURE_BINDING | TextureUsage.RENDER_ATTACHMENT;
    this.ldr = device.createTexture({
      label: "ldr",
      size: [width, height],
      format: COLOR_FORMAT,
      usage,
    });
    this.ldrView = this.ldr.createView();
  }

  /** The decoded HDR image, allocated when a stage first needs it. */
  private ensureHdr(): GPUTextureView {
    if (!this.hdrView) {
      this.hdr = this.core.device.createTexture({
        label: "hdr",
        size: [this.width, this.height],
        format: COLOR_FORMAT,
        usage: TextureUsage.TEXTURE_BINDING | TextureUsage.RENDER_ATTACHMENT,
      });
      this.hdrView = this.hdr.createView();
    }
    return this.hdrView;
  }

  encode(encoder: GPUCommandEncoder, input: PostInput) {
    const { device, post, dummies } = this.core;
    const env = input.environment;
    const high = input.quality === "high" && !input.bypass;
    const useBloom = high && env.bloom > 0;
    const useAuto = high && env.autoExposure;
    const decode = useBloom || useAuto;
    let passes = 0;

    const hdrView = decode ? this.ensureHdr() : undefined;
    if (decode) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: hdrView!,
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setPipeline(post.decode);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: post.decodeLayout,
          entries: [
            { binding: 0, resource: input.scene },
            { binding: 1, resource: input.transparency ?? dummies.transparent },
          ],
        }),
      );
      pass.draw(3);
      pass.end();
      passes++;
    }
    if (useAuto) {
      if (!this.exposure) {
        this.exposure = new AutoExposure(this.core);
        this.exposure.resize(this.width, this.height, hdrView!);
      }
      if (input.still) this.exposure.reset();
      this.exposure.encode(encoder, input.dt);
      passes += this.exposure.passCount;
    } else {
      // Drop the adapted value: re-enabling starts from the scene as it is.
      this.exposure?.reset();
    }
    if (useBloom) {
      this.bloom ??= new Bloom(
        this.core,
        this.width,
        this.height,
        hdrView!,
      );
      this.bloom.encode(encoder);
      passes += this.bloom.levels * 2 - 1;
    }

    const bg = input.background;
    device.queue.writeBuffer(
      this.uniform,
      0,
      new Float32Array([
        this.width,
        this.height,
        2 ** env.exposure,
        env.bloom,
        TONEMAP_INDEX[env.tonemap],
        env.contrast,
        env.saturation,
        env.temperature,
        env.vignette,
        env.grain,
        input.frame,
        useAuto ? 1 : 0,
        input.bypass ? 1 : 0,
        useBloom ? 1 : 0,
        input.overlay ? 1 : 0,
        decode ? 0 : 1,
        bg ? bg[0] : 0,
        bg ? bg[1] : 0,
        bg ? bg[2] : 0,
        bg ? 1 : 0,
        input.transparency ? 1 : 0,
        0,
        0,
        0,
      ]),
    );
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.ldrView!,
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(post.tonemap);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: post.tonemapLayout,
        entries: [
          { binding: 0, resource: hdrView ?? input.scene },
          {
            binding: 1,
            resource: useBloom ? this.bloom!.output : dummies.black,
          },
          { binding: 2, resource: input.overlay ?? dummies.transparent },
          {
            binding: 3,
            resource: useAuto ? this.exposure!.output : dummies.exposure,
          },
          { binding: 4, resource: { buffer: this.uniform } },
          { binding: 5, resource: dummies.blueNoise },
          { binding: 6, resource: post.sampler },
          { binding: 7, resource: input.transparency ?? dummies.transparent },
        ],
      }),
    );
    pass.draw(3);
    pass.end();
    this.stats = { passes: passes + 1 };
  }

  dispose() {
    this.hdr?.destroy();
    this.ldr?.destroy();
    this.bloom?.destroy();
    this.exposure?.destroy();
    this.uniform.destroy();
  }
}
