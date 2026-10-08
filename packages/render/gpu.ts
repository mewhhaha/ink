/** Small WebGPU helpers shared by the renderer's modules. */

/** WebGPU flag values, spelled out so modules work where the `GPU*` globals
 * are missing (workers, some runtimes). */
export const BufferUsage = {
  MAP_READ: 1,
  COPY_SRC: 4,
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
} as const;
export const TextureUsage = {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
} as const;
export const ShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 } as const;
export const MAP_READ = 1;

/** Scene radiance (linear HDR). The MSAA target stores it tonemap-weighted
 * (see shaders/hdr.ts) so the hardware resolve does not alias bright edges. */
export const COLOR_FORMAT: GPUTextureFormat = "rgba16float";
/** Overlay layer: premultiplied, blended in linear light, stored as sRGB. */
export const OVERLAY_FORMAT: GPUTextureFormat = "rgba8unorm-srgb";
export const DEPTH_FORMAT: GPUTextureFormat = "depth32float";
export const SAMPLES = 4;
/** Bytes per vertex: pos3 normal3 uv2 color4 face1. */
export const VERTEX_STRIDE = 52;
/** Floats per mesh instance (see `Instance` in the scene shader). */
export const INSTANCE_FLOATS = 44;

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** A buffer that grows (never shrinks) to fit what is written to it. */
export class GrowBuffer {
  buffer: GPUBuffer;
  constructor(
    private device: GPUDevice,
    private usage: GPUBufferUsageFlags,
    private label: string,
    private bytes = 256,
  ) {
    this.buffer = this.create(bytes);
  }

  private create(bytes: number): GPUBuffer {
    return this.device.createBuffer({
      label: this.label,
      size: bytes,
      usage: this.usage | BufferUsage.COPY_DST,
    });
  }

  /** Make room for `bytes`; returns true if the buffer was replaced (any bind
   * group built on it is stale). */
  reserve(bytes: number): boolean {
    if (bytes <= this.bytes) return false;
    let next = this.bytes;
    while (next < bytes) next *= 2;
    this.buffer.destroy();
    this.bytes = next;
    this.buffer = this.create(next);
    return true;
  }

  destroy() {
    this.buffer.destroy();
  }
}

export function texture2d(
  device: GPUDevice,
  label: string,
  width: number,
  height: number,
  format: GPUTextureFormat,
  usage: GPUTextureUsageFlags,
  sampleCount = 1,
): GPUTexture {
  return device.createTexture({
    label,
    size: [Math.max(1, width), Math.max(1, height)],
    format,
    usage,
    sampleCount,
  });
}
