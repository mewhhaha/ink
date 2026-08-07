import type { Observer } from "@ink/observability/observer.ts";
import type { DrawPacket, RenderWorld } from "./extraction.ts";
import type { RenderDevice, SubmittedRenderFrame } from "./device.ts";
import {
  type RenderDeviceState,
  type RenderFrame,
  type RenderQualityProfile,
  type RenderSurface,
  select_quality_profile,
} from "./model.ts";
import { build_rendering_path, type RenderingPathPlan } from "./paths.ts";
import type { RenderResourcePool } from "./resources.ts";

export type RenderPreparation =
  | {
    readonly type: "ready";
    readonly frame: RenderFrame;
    readonly plan: RenderingPathPlan;
  }
  | { readonly type: "semantic_only"; readonly reason: string };

export class Renderer {
  readonly #resources: RenderResourcePool;
  readonly #observer: Observer | undefined;
  #device: RenderDevice;
  #quality: RenderQualityProfile;
  #active: RenderPreparation | undefined;
  #remove_loss_listener: () => void;

  constructor(
    options: {
      readonly device: RenderDevice;
      readonly quality: RenderQualityProfile;
      readonly resources: RenderResourcePool;
      readonly observer?: Observer;
    },
  ) {
    this.#device = options.device;
    const selection = select_quality_profile(
      options.quality,
      options.device.capabilities,
    );
    if (selection.type === "unsupported") throw new Error(selection.reason);
    this.#quality = selection.profile;
    this.#resources = options.resources;
    this.#observer = options.observer;
    this.#remove_loss_listener = this.#listen_for_loss(options.device);
    if (selection.degraded_from !== undefined) {
      options.observer?.event("render.quality.degraded", {
        requested: selection.degraded_from,
        selected: selection.profile.path,
      });
    }
  }

  get state(): RenderDeviceState {
    return this.#device.state;
  }

  get quality(): RenderQualityProfile {
    return this.#quality;
  }

  prepare(
    surface: RenderSurface,
    world: RenderWorld,
    packets: readonly DrawPacket[],
    started_seconds: number,
  ): RenderPreparation {
    if (this.#active !== undefined) {
      throw new Error("render preparation is already active");
    }
    if (this.#device.state.type !== "ready") {
      return {
        type: "semantic_only",
        reason: device_reason(this.#device.state),
      };
    }
    const plan = build_rendering_path(this.#quality, surface, world, packets);
    const frame = this.#device.begin_frame(surface, started_seconds);
    const preparation = { type: "ready" as const, frame, plan };
    this.#active = preparation;
    this.#observer?.event("render.frame.prepared", {
      frame: frame.id,
      path: plan.path,
      visible_draws: packets.length,
      passes: plan.graph.passes.length,
    });
    return preparation;
  }

  submit(
    preparation: Extract<RenderPreparation, { readonly type: "ready" }>,
    command_buffers: readonly GPUCommandBuffer[],
  ): void {
    if (
      this.#active?.type !== "ready" ||
      this.#active.frame.id !== preparation.frame.id
    ) {
      throw new Error(
        `render frame ${preparation.frame.id} is not the active preparation`,
      );
    }
    const submission: SubmittedRenderFrame = {
      frame: preparation.frame,
      command_buffers,
    };
    try {
      this.#device.submit(submission);
    } finally {
      this.#active = undefined;
    }
  }

  recover(
    device: RenderDevice,
    requested_quality: RenderQualityProfile = this.#quality,
  ): void {
    if (device.state.type !== "ready") {
      throw new Error(`render recovery device is ${device.state.type}`);
    }
    const selection = select_quality_profile(
      requested_quality,
      device.capabilities,
    );
    if (selection.type === "unsupported") throw new Error(selection.reason);
    this.#remove_loss_listener();
    this.#device = device;
    this.#quality = selection.profile;
    this.#active = undefined;
    this.#remove_loss_listener = this.#listen_for_loss(device);
    this.#observer?.event("render.device.recovered", {
      adapter: device.capabilities.adapter,
      path: selection.profile.path,
    });
  }

  destroy(): void {
    this.#remove_loss_listener();
    this.#resources.clear_after_device_loss();
    this.#device.destroy();
    this.#active = undefined;
  }

  #listen_for_loss(device: RenderDevice): () => void {
    return device.on_loss((state) => {
      const stale = this.#resources.clear_after_device_loss();
      this.#active = undefined;
      this.#observer?.event("render.device.resources_released", {
        adapter: state.adapter,
        resource_count: stale.length,
      });
    });
  }
}

function device_reason(state: RenderDeviceState): string {
  if (state.type === "unavailable" || state.type === "lost") {
    return state.reason;
  }
  if (state.type === "recovering") {
    return `render adapter ${state.adapter} is recovering attempt ${state.attempt}`;
  }
  return `render device is ${state.type}`;
}
