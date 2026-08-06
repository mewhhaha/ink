import {
  render_surface,
  type RenderSurface,
  type RenderSurfaceId,
} from "./model.ts";

export class WebGpuSurface {
  readonly #context: GPUCanvasContext;
  readonly #device: GPUDevice;
  readonly #id: RenderSurfaceId;
  readonly #format: GPUTextureFormat;
  #surface: RenderSurface;

  constructor(
    options: {
      readonly canvas: HTMLCanvasElement | OffscreenCanvas;
      readonly device: GPUDevice;
      readonly id: RenderSurfaceId;
      readonly width: number;
      readonly height: number;
      readonly format?: GPUTextureFormat;
      readonly alpha_mode?: GPUCanvasAlphaMode;
    },
  ) {
    const context = options.canvas.getContext("webgpu");
    if (context === null || !("configure" in context)) {
      throw new Error(
        `render surface ${
          JSON.stringify(options.id)
        } could not acquire a WebGPU canvas context`,
      );
    }
    this.#context = context as GPUCanvasContext;
    this.#device = options.device;
    this.#id = options.id;
    this.#format = options.format ?? navigator.gpu.getPreferredCanvasFormat();
    this.#surface = render_surface({
      id: options.id,
      width: options.width,
      height: options.height,
      format: this.#format,
      revision: 0,
    });
    this.#context.configure({
      device: options.device,
      format: this.#format,
      alphaMode: options.alpha_mode ?? "premultiplied",
    });
  }

  get snapshot(): RenderSurface {
    return this.#surface;
  }

  resize(width: number, height: number): RenderSurface {
    this.#surface = render_surface({
      id: this.#id,
      width,
      height,
      format: this.#format,
      revision: this.#surface.revision + 1,
    });
    this.#context.configure({
      device: this.#device,
      format: this.#format,
      alphaMode: "premultiplied",
    });
    return this.#surface;
  }

  current_texture(): GPUTexture {
    try {
      return this.#context.getCurrentTexture();
    } catch (error) {
      throw new Error(
        `render surface ${
          JSON.stringify(this.#id)
        } revision ${this.#surface.revision} failed to acquire its texture: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  unconfigure(): void {
    this.#context.unconfigure();
  }
}
