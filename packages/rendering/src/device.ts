import type { Observer } from "@ink/observability/observer.ts";
import {
  render_frame_id,
  type RenderCapabilities,
  type RenderDeviceState,
  type RenderFrame,
  type RenderSurface,
} from "./model.ts";

export interface SubmittedRenderFrame {
  readonly frame: RenderFrame;
  readonly command_buffers: readonly GPUCommandBuffer[];
}

export interface RenderDevice {
  readonly capabilities: RenderCapabilities;
  readonly state: RenderDeviceState;
  begin_frame(surface: RenderSurface, started_seconds: number): RenderFrame;
  submit(frame: SubmittedRenderFrame): void;
  on_loss(
    listener: (
      state: Extract<RenderDeviceState, { readonly type: "lost" }>,
    ) => void,
  ): () => void;
  destroy(): void;
}

export interface WebGpuRequestOptions {
  readonly power_preference?: GPUPowerPreference;
  readonly required_features?: readonly GPUFeatureName[];
  readonly observer?: Observer;
}

export type RenderDeviceRequest =
  | {
    readonly type: "ready";
    readonly device: RenderDevice;
    readonly gpu: GPUDevice;
  }
  | { readonly type: "unavailable"; readonly reason: string };

export async function request_webgpu_device(
  options: WebGpuRequestOptions = {},
): Promise<RenderDeviceRequest> {
  if (navigator.gpu === undefined) {
    return { type: "unavailable", reason: "WebGPU is unavailable" };
  }
  let adapter: GPUAdapter | null;
  try {
    adapter = await navigator.gpu.requestAdapter({
      powerPreference: options.power_preference,
    });
  } catch (error) {
    return {
      type: "unavailable",
      reason: `WebGPU adapter request failed: ${message(error)}`,
    };
  }
  if (adapter === null) {
    return {
      type: "unavailable",
      reason: "WebGPU returned no compatible adapter",
    };
  }
  const missing = (options.required_features ?? []).filter((feature) =>
    !adapter.features.has(feature)
  );
  if (missing.length > 0) {
    return {
      type: "unavailable",
      reason: `WebGPU adapter is missing required features ${
        missing.join(", ")
      }`,
    };
  }
  let gpu: GPUDevice;
  try {
    gpu = await adapter.requestDevice({
      requiredFeatures: [...(options.required_features ?? [])],
    });
  } catch (error) {
    return {
      type: "unavailable",
      reason: `WebGPU device request failed: ${message(error)}`,
    };
  }
  const description = adapter.info.description ||
    `${adapter.info.vendor} ${adapter.info.architecture}`.trim() ||
    "WebGPU adapter";
  const capabilities: RenderCapabilities = {
    adapter: description,
    maximum_texture_dimension_2d: adapter.limits.maxTextureDimension2D,
    maximum_buffer_bytes: adapter.limits.maxBufferSize,
    maximum_sample_count: 4,
    timestamp_queries: adapter.features.has("timestamp-query"),
    indirect_draw: true,
    depth_clip_control: adapter.features.has("depth-clip-control"),
    supported_paths: new Set([
      "compatibility",
      "clustered_forward",
      "deferred",
    ]),
  };
  return {
    type: "ready",
    device: new WebGpuRenderDevice(gpu, capabilities, options.observer),
    gpu,
  };
}

export class WebGpuRenderDevice implements RenderDevice {
  readonly #gpu: GPUDevice;
  readonly #observer: Observer | undefined;
  readonly #loss_listeners = new Set<
    (state: Extract<RenderDeviceState, { readonly type: "lost" }>) => void
  >();
  readonly capabilities: RenderCapabilities;
  #state: RenderDeviceState;
  #next_frame = 0;
  #active_frame: RenderFrame | undefined;

  constructor(
    gpu: GPUDevice,
    capabilities: RenderCapabilities,
    observer?: Observer,
  ) {
    this.#gpu = gpu;
    this.capabilities = capabilities;
    this.#observer = observer;
    this.#state = { type: "ready", adapter: capabilities.adapter };
    void gpu.lost.then((loss) => {
      const state = {
        type: "lost" as const,
        adapter: capabilities.adapter,
        reason: `${loss.reason}: ${loss.message}`,
      };
      this.#state = state;
      observer?.diagnostic("error", "render.device_lost", state.reason, {
        adapter: capabilities.adapter,
      });
      for (const listener of this.#loss_listeners) listener(state);
    });
  }

  get state(): RenderDeviceState {
    return this.#state;
  }

  begin_frame(surface: RenderSurface, started_seconds: number): RenderFrame {
    if (this.#state.type !== "ready") {
      throw new Error(
        `render adapter ${
          JSON.stringify(this.capabilities.adapter)
        } cannot begin a frame while ${this.#state.type}`,
      );
    }
    if (this.#active_frame !== undefined) {
      throw new Error(
        `render frame ${this.#active_frame.id} is still active on surface ${
          JSON.stringify(this.#active_frame.surface.id)
        }`,
      );
    }
    if (!Number.isFinite(started_seconds) || started_seconds < 0) {
      throw new Error(
        `render frame start ${
          JSON.stringify(started_seconds)
        } must be nonnegative`,
      );
    }
    const frame = {
      id: render_frame_id(this.#next_frame),
      surface,
      started_seconds,
    };
    if (this.#next_frame === Number.MAX_SAFE_INTEGER) {
      throw new Error("render frame identity exceeds safe integer range");
    }
    this.#next_frame += 1;
    this.#active_frame = frame;
    return frame;
  }

  submit(submission: SubmittedRenderFrame): void {
    if (this.#active_frame?.id !== submission.frame.id) {
      throw new Error(
        `render submitted frame ${submission.frame.id} does not match active frame ${
          this.#active_frame?.id ?? "none"
        }`,
      );
    }
    try {
      this.#gpu.queue.submit(submission.command_buffers);
      this.#active_frame = undefined;
    } catch (error) {
      this.#active_frame = undefined;
      throw new Error(
        `render adapter ${
          JSON.stringify(this.capabilities.adapter)
        } failed to submit frame ${submission.frame.id}: ${message(error)}`,
        { cause: error },
      );
    }
    this.#observer?.event("render.frame.submitted", {
      frame: submission.frame.id,
      command_buffers: submission.command_buffers.length,
    });
  }

  on_loss(
    listener: (
      state: Extract<RenderDeviceState, { readonly type: "lost" }>,
    ) => void,
  ): () => void {
    this.#loss_listeners.add(listener);
    return () => this.#loss_listeners.delete(listener);
  }

  destroy(): void {
    this.#active_frame = undefined;
    this.#loss_listeners.clear();
    this.#gpu.destroy();
    this.#state = {
      type: "unavailable",
      reason: "render device was destroyed",
    };
  }
}

export class SemanticOnlyRenderDevice implements RenderDevice {
  readonly capabilities: RenderCapabilities;
  readonly state: RenderDeviceState;

  constructor(reason: string) {
    if (typeof reason !== "string") {
      throw new Error("semantic-only render reason must be a string");
    }
    const parsed = reason.trim();
    if (parsed.length === 0) {
      throw new Error(
        `semantic-only render reason ${JSON.stringify(reason)} cannot be empty`,
      );
    }
    this.capabilities = {
      adapter: "semantic-only",
      maximum_texture_dimension_2d: 0,
      maximum_buffer_bytes: 0,
      maximum_sample_count: 1,
      timestamp_queries: false,
      indirect_draw: false,
      depth_clip_control: false,
      supported_paths: new Set(),
    };
    this.state = { type: "unavailable", reason: parsed };
  }

  begin_frame(_surface: RenderSurface, _started_seconds: number): RenderFrame {
    throw new Error(
      `semantic-only renderer cannot begin a GPU frame: ${
        (this.state as { reason: string }).reason
      }`,
    );
  }
  submit(_frame: SubmittedRenderFrame): void {}
  on_loss(
    _listener: (
      state: Extract<RenderDeviceState, { readonly type: "lost" }>,
    ) => void,
  ): () => void {
    return () => {};
  }
  destroy(): void {}
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
