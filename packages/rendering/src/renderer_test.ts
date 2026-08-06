import { assertEquals } from "@std/assert";
import type { RenderDevice, SubmittedRenderFrame } from "./device.ts";
import {
  render_frame_id,
  render_surface,
  render_surface_id,
  type RenderCapabilities,
  type RenderDeviceState,
  type RenderFrame,
  type RenderQualityProfile,
} from "./model.ts";
import { Renderer } from "./renderer.ts";
import { RenderResourcePool } from "./resources.ts";

class FakeDevice implements RenderDevice {
  readonly capabilities: RenderCapabilities = {
    adapter: "fake",
    maximum_texture_dimension_2d: 4_096,
    maximum_buffer_bytes: 1_000_000,
    maximum_sample_count: 4,
    timestamp_queries: false,
    indirect_draw: true,
    depth_clip_control: false,
    supported_paths: new Set([
      "compatibility",
      "clustered_forward",
      "deferred",
    ]),
  };
  state: RenderDeviceState = { type: "ready", adapter: "fake" };
  #listeners = new Set<
    (state: Extract<RenderDeviceState, { type: "lost" }>) => void
  >();
  submitted = 0;

  begin_frame(
    surface: Parameters<RenderDevice["begin_frame"]>[0],
    started_seconds: number,
  ): RenderFrame {
    return { id: render_frame_id(0), surface, started_seconds };
  }
  submit(_frame: SubmittedRenderFrame): void {
    this.submitted += 1;
  }
  on_loss(
    listener: (state: Extract<RenderDeviceState, { type: "lost" }>) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  destroy(): void {
    this.state = { type: "unavailable", reason: "destroyed" };
  }
  lose(): void {
    const state = {
      type: "lost" as const,
      adapter: "fake",
      reason: "fixture reset",
    };
    this.state = state;
    for (const listener of this.#listeners) listener(state);
  }
}

const quality: RenderQualityProfile = {
  path: "clustered_forward",
  hdr_format: "rgba16float",
  depth: "reversed",
  sample_count: 1,
  anti_aliasing: "none",
  upscaling: { type: "native" },
  bloom: false,
  color_grading: false,
  maximum_lights: 16,
  maximum_shadow_lights: 2,
};

Deno.test("renderer submits one active preparation and survives device loss semantically", () => {
  const device = new FakeDevice();
  const resources = new RenderResourcePool({
    maximum_bytes: 1_024,
    maximum_resources: 4,
    deferred_frame_count: 1,
  });
  const renderer = new Renderer({ device, quality, resources });
  const surface = render_surface({
    id: render_surface_id("main"),
    width: 10,
    height: 10,
    format: "bgra8unorm",
    revision: 0,
  });
  const world = {
    scene_revision: 0,
    visible_revision: 0,
    material_revision: 0,
    light_revision: 0,
    transform_revision: 0,
    renderables: [],
    lighting: {},
  } as never;
  const preparation = renderer.prepare(surface, world, [], 0);
  if (preparation.type !== "ready") throw new Error(preparation.reason);
  renderer.submit(preparation, []);
  assertEquals(device.submitted, 1);
  device.lose();
  assertEquals(renderer.prepare(surface, world, [], 1), {
    type: "semantic_only",
    reason: "fixture reset",
  });
  assertEquals(resources.snapshot().retained_bytes, 0);
});
