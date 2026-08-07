import type { Observer } from "@ink/observability/observer.ts";
import {
  render_frame_id,
  render_resource_id,
  type RenderFrameId,
  type RenderResourceId,
} from "./model.ts";

export type RenderResourceDescriptor =
  | {
    readonly type: "buffer";
    readonly size_bytes: number;
    readonly usage: number;
    readonly fallback?: "zero_buffer";
  }
  | {
    readonly type: "texture";
    readonly width: number;
    readonly height: number;
    readonly depth_or_layers: number;
    readonly mip_levels: number;
    readonly sample_count: 1 | 4;
    readonly format: GPUTextureFormat;
    readonly usage: number;
    readonly fallback?: "white" | "black" | "normal" | "checkerboard";
  }
  | { readonly type: "sampler"; readonly fingerprint: string }
  | { readonly type: "shader"; readonly source: string; readonly label: string }
  | { readonly type: "pipeline"; readonly fingerprint: string }
  | { readonly type: "bind_group"; readonly fingerprint: string };

export interface RenderResource {
  readonly id: RenderResourceId;
  readonly revision: number;
  readonly descriptor: RenderResourceDescriptor;
  readonly size_bytes: number;
  readonly last_used_frame: RenderFrameId;
}

export interface ResourceBudget {
  readonly maximum_bytes: number;
  readonly maximum_resources: number;
  readonly deferred_frame_count: number;
}

export interface ResourcePoolSnapshot {
  readonly retained_bytes: number;
  readonly resource_count: number;
  readonly deferred_count: number;
  readonly resources: readonly RenderResource[];
}

interface DeferredResource {
  readonly resource: RenderResource;
  readonly destroy_after: number;
}

export class RenderResourcePool {
  readonly #budget: ResourceBudget;
  readonly #observer: Observer | undefined;
  readonly #resources = new Map<RenderResourceId, RenderResource>();
  readonly #deferred: DeferredResource[] = [];
  #retained_bytes = 0;

  constructor(budget: ResourceBudget, observer?: Observer) {
    if (
      !Number.isSafeInteger(budget.maximum_bytes) || budget.maximum_bytes <= 0
    ) {
      throw new Error(
        `render resource budget bytes ${
          JSON.stringify(budget.maximum_bytes)
        } must be positive`,
      );
    }
    if (
      !Number.isSafeInteger(budget.maximum_resources) ||
      budget.maximum_resources <= 0
    ) {
      throw new Error(
        `render resource budget count ${
          JSON.stringify(budget.maximum_resources)
        } must be positive`,
      );
    }
    if (
      !Number.isSafeInteger(budget.deferred_frame_count) ||
      budget.deferred_frame_count < 0
    ) {
      throw new Error(
        `render resource deferred frames ${
          JSON.stringify(budget.deferred_frame_count)
        } must be nonnegative`,
      );
    }
    this.#budget = budget;
    this.#observer = observer;
  }

  create(
    id: RenderResourceId,
    descriptor: RenderResourceDescriptor,
    frame: RenderFrameId,
  ): RenderResource {
    id = render_resource_id(id);
    frame = render_frame_id(frame);
    if (this.#resources.has(id)) {
      throw new Error(`render resource ${JSON.stringify(id)} already exists`);
    }
    const size_bytes = resource_size(descriptor);
    if (
      this.#resources.size + this.#deferred.length + 1 >
        this.#budget.maximum_resources ||
      this.#retained_bytes + size_bytes > this.#budget.maximum_bytes
    ) {
      throw new Error(
        `render resource ${
          JSON.stringify(id)
        } needs ${size_bytes} bytes; pool retains ${this.#retained_bytes}/${this.#budget.maximum_bytes} bytes and ${this.#resources.size}/${this.#budget.maximum_resources} resources`,
      );
    }
    const resource = Object.freeze({
      id,
      revision: 0,
      descriptor: render_resource_descriptor(descriptor),
      size_bytes,
      last_used_frame: frame,
    });
    this.#resources.set(id, resource);
    this.#retained_bytes += size_bytes;
    this.#observer?.event("render.resource.created", {
      resource: id,
      size_bytes,
    });
    return resource;
  }

  replace(
    id: RenderResourceId,
    descriptor: RenderResourceDescriptor,
    frame: RenderFrameId,
  ): RenderResource {
    id = render_resource_id(id);
    frame = render_frame_id(frame);
    const current = this.#resources.get(id);
    if (current === undefined) {
      throw new Error(
        `render resource ${
          JSON.stringify(id)
        } cannot be replaced because it is missing`,
      );
    }
    const size_bytes = resource_size(descriptor);
    if (current.revision === Number.MAX_SAFE_INTEGER) {
      throw new Error(
        `render resource ${
          JSON.stringify(id)
        } revision exceeds safe integer range`,
      );
    }
    const next_bytes = this.#retained_bytes + size_bytes;
    if (
      next_bytes > this.#budget.maximum_bytes ||
      this.#resources.size + this.#deferred.length + 1 >
        this.#budget.maximum_resources
    ) {
      throw new Error(
        `render resource ${
          JSON.stringify(id)
        } replacement needs pool total ${next_bytes}/${this.#budget.maximum_bytes} bytes`,
      );
    }
    const resource = Object.freeze({
      id,
      revision: current.revision + 1,
      descriptor: render_resource_descriptor(descriptor),
      size_bytes,
      last_used_frame: frame,
    });
    this.#resources.set(id, resource);
    this.#retained_bytes = next_bytes;
    this.#deferred.push({
      resource: current,
      destroy_after: deferred_frame(frame, this.#budget.deferred_frame_count),
    });
    return resource;
  }

  use(id: RenderResourceId, frame: RenderFrameId): RenderResource {
    id = render_resource_id(id);
    frame = render_frame_id(frame);
    const resource = this.#resources.get(id);
    if (resource === undefined) {
      throw new Error(
        `render resource ${JSON.stringify(id)} is missing at frame ${frame}`,
      );
    }
    const used = Object.freeze({ ...resource, last_used_frame: frame });
    this.#resources.set(id, used);
    return used;
  }

  release(id: RenderResourceId, frame: RenderFrameId): void {
    id = render_resource_id(id);
    frame = render_frame_id(frame);
    const resource = this.#resources.get(id);
    if (resource === undefined) return;
    this.#resources.delete(id);
    this.#deferred.push({
      resource,
      destroy_after: deferred_frame(frame, this.#budget.deferred_frame_count),
    });
  }

  collect(completed_frame: RenderFrameId): readonly RenderResource[] {
    completed_frame = render_frame_id(completed_frame);
    const destroyed: RenderResource[] = [];
    for (let index = this.#deferred.length - 1; index >= 0; index -= 1) {
      if (this.#deferred[index].destroy_after > completed_frame) continue;
      destroyed.push(this.#deferred[index].resource);
      this.#retained_bytes -= this.#deferred[index].resource.size_bytes;
      this.#deferred.splice(index, 1);
    }
    destroyed.sort((left, right) => left.id.localeCompare(right.id));
    if (destroyed.length > 0) {
      this.#observer?.event("render.resource.destroyed", {
        resource_count: destroyed.length,
      });
    }
    return Object.freeze(destroyed);
  }

  clear_after_device_loss(): readonly RenderResource[] {
    const stale = [
      ...this.#resources.values(),
      ...this.#deferred.map((entry) => entry.resource),
    ]
      .sort((left, right) => left.id.localeCompare(right.id));
    this.#resources.clear();
    this.#deferred.splice(0);
    this.#retained_bytes = 0;
    return Object.freeze(stale);
  }

  snapshot(): ResourcePoolSnapshot {
    return Object.freeze({
      retained_bytes: this.#retained_bytes,
      resource_count: this.#resources.size,
      deferred_count: this.#deferred.length,
      resources: Object.freeze(
        [...this.#resources.values()].sort((left, right) =>
          left.id.localeCompare(right.id)
        ),
      ),
    });
  }
}

export interface StagingUpload {
  readonly destination: RenderResourceId;
  readonly destination_offset: number;
  readonly bytes: Uint8Array;
}

export function staging_upload(
  destination: RenderResourceId,
  destination_offset: number,
  bytes: Uint8Array,
): StagingUpload {
  destination = render_resource_id(destination);
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(
      `render upload ${JSON.stringify(destination)} bytes must be a Uint8Array`,
    );
  }
  if (
    !Number.isSafeInteger(destination_offset) || destination_offset < 0 ||
    destination_offset % 4 !== 0
  ) {
    throw new Error(
      `render upload ${JSON.stringify(destination)} offset ${
        JSON.stringify(destination_offset)
      } must be nonnegative and 4-byte aligned`,
    );
  }
  if (bytes.length === 0 || bytes.length % 4 !== 0) {
    throw new Error(
      `render upload ${
        JSON.stringify(destination)
      } byte length ${bytes.length} must be positive and 4-byte aligned`,
    );
  }
  return Object.freeze({
    destination,
    destination_offset,
    bytes: new Uint8Array(bytes),
  });
}

export function fallback_resource_id(
  kind: "zero_buffer" | "white" | "black" | "normal" | "checkerboard",
): RenderResourceId {
  return render_resource_id(`fallback:${kind}`);
}

export function render_resource_descriptor(
  descriptor: RenderResourceDescriptor,
): RenderResourceDescriptor {
  resource_size(descriptor);
  return Object.freeze(copy_descriptor(descriptor));
}

function resource_size(descriptor: RenderResourceDescriptor): number {
  const type = descriptor.type as string;
  if (
    !["buffer", "texture", "sampler", "shader", "pipeline", "bind_group"]
      .includes(type)
  ) {
    throw new Error(
      `render resource descriptor type ${JSON.stringify(type)} is unsupported`,
    );
  }
  if (descriptor.type === "buffer") {
    if (
      !Number.isSafeInteger(descriptor.size_bytes) || descriptor.size_bytes <= 0
    ) {
      throw new Error(
        `render buffer size ${
          JSON.stringify(descriptor.size_bytes)
        } must be positive`,
      );
    }
    validate_usage(descriptor.usage, "buffer");
    return descriptor.size_bytes;
  }
  if (descriptor.type !== "texture") {
    const text = descriptor.type === "shader"
      ? descriptor.source
      : descriptor.type === "sampler" || descriptor.type === "pipeline" ||
          descriptor.type === "bind_group"
      ? descriptor.fingerprint
      : "";
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error(
        `render ${descriptor.type} descriptor text cannot be empty`,
      );
    }
    if (
      descriptor.type === "shader" &&
      (typeof descriptor.label !== "string" ||
        descriptor.label.trim().length === 0)
    ) {
      throw new Error("render shader descriptor label cannot be empty");
    }
    return 0;
  }
  for (
    const [label, value] of [
      ["width", descriptor.width],
      ["height", descriptor.height],
      ["layers", descriptor.depth_or_layers],
      ["mips", descriptor.mip_levels],
    ] as const
  ) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `render texture ${label} ${JSON.stringify(value)} must be positive`,
      );
    }
  }
  if (descriptor.sample_count !== 1 && descriptor.sample_count !== 4) {
    throw new Error(
      `render texture sample count ${
        JSON.stringify(descriptor.sample_count)
      } must be 1 or 4`,
    );
  }
  if (
    typeof descriptor.format !== "string" ||
    descriptor.format.trim().length === 0
  ) {
    throw new Error("render texture format cannot be empty");
  }
  validate_usage(descriptor.usage, "texture");
  const bytes_per_pixel = descriptor.format.includes("16float")
    ? 8
    : descriptor.format.includes("32float")
    ? 16
    : 4;
  const mip_factor = descriptor.mip_levels === 1 ? 1 : 4 / 3;
  const size = Math.ceil(
    descriptor.width * descriptor.height * descriptor.depth_or_layers *
      descriptor.sample_count * bytes_per_pixel * mip_factor,
  );
  if (!Number.isSafeInteger(size)) {
    throw new Error(
      `render texture ${descriptor.width}x${descriptor.height}x${descriptor.depth_or_layers} size exceeds safe integer range`,
    );
  }
  return size;
}

function copy_descriptor(
  descriptor: RenderResourceDescriptor,
): RenderResourceDescriptor {
  return descriptor.type === "shader"
    ? { ...descriptor, source: `${descriptor.source}` }
    : { ...descriptor };
}

function validate_usage(value: number, resource: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff) {
    throw new Error(
      `render ${resource} usage ${
        JSON.stringify(value)
      } must be an unsigned nonzero 32-bit integer`,
    );
  }
}

function deferred_frame(frame: number, count: number): number {
  const result = frame + count;
  if (!Number.isSafeInteger(result)) {
    throw new Error(
      `render deferred frame ${frame} + ${count} exceeds safe integer range`,
    );
  }
  return result;
}
