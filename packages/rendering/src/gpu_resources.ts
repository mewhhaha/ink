import type { RenderResource } from "./resources.ts";

export type NativeRenderResource =
  | GPUBuffer
  | GPUTexture
  | GPUSampler
  | GPUShaderModule
  | GPURenderPipeline
  | GPUComputePipeline
  | GPUBindGroup;

export interface NativeResourceFactories {
  readonly pipeline?: (
    resource: RenderResource,
    device: GPUDevice,
  ) => GPURenderPipeline | GPUComputePipeline;
  readonly bind_group?: (
    resource: RenderResource,
    device: GPUDevice,
  ) => GPUBindGroup;
}

export class WebGpuResources {
  readonly #device: GPUDevice;
  readonly #resources = new Map<
    string,
    { readonly revision: number; readonly value: NativeRenderResource }
  >();

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  install(
    resource: RenderResource,
    factories: NativeResourceFactories = {},
  ): NativeRenderResource {
    const existing = this.#resources.get(resource.id);
    if (existing !== undefined && existing.revision >= resource.revision) {
      throw new Error(
        `render native resource ${
          JSON.stringify(resource.id)
        } revision ${resource.revision} must exceed installed revision ${existing.revision}`,
      );
    }
    let value: NativeRenderResource;
    const descriptor = resource.descriptor;
    try {
      if (descriptor.type === "buffer") {
        value = this.#device.createBuffer({
          label: resource.id,
          size: descriptor.size_bytes,
          usage: descriptor.usage,
        });
      } else if (descriptor.type === "texture") {
        value = this.#device.createTexture({
          label: resource.id,
          size: [
            descriptor.width,
            descriptor.height,
            descriptor.depth_or_layers,
          ],
          mipLevelCount: descriptor.mip_levels,
          sampleCount: descriptor.sample_count,
          format: descriptor.format,
          usage: descriptor.usage,
        });
      } else if (descriptor.type === "sampler") {
        value = this.#device.createSampler({
          label: `${resource.id}:${descriptor.fingerprint}`,
        });
      } else if (descriptor.type === "shader") {
        value = this.#device.createShaderModule({
          label: descriptor.label,
          code: descriptor.source,
        });
      } else if (descriptor.type === "pipeline") {
        if (factories.pipeline === undefined) {
          throw new Error("pipeline factory is missing");
        }
        value = factories.pipeline(resource, this.#device);
      } else {
        if (factories.bind_group === undefined) {
          throw new Error("bind-group factory is missing");
        }
        value = factories.bind_group(resource, this.#device);
      }
    } catch (error) {
      throw new Error(
        `render native resource ${
          JSON.stringify(resource.id)
        } revision ${resource.revision} creation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (existing !== undefined) destroy_native(existing.value);
    this.#resources.set(resource.id, { revision: resource.revision, value });
    return value;
  }

  get(id: string): NativeRenderResource | undefined {
    return this.#resources.get(id)?.value;
  }

  destroy(resources: readonly RenderResource[]): void {
    for (const resource of resources) {
      const native = this.#resources.get(resource.id);
      if (native === undefined || native.revision !== resource.revision) {
        continue;
      }
      destroy_native(native.value);
      this.#resources.delete(resource.id);
    }
  }

  clear(): void {
    for (const native of this.#resources.values()) destroy_native(native.value);
    this.#resources.clear();
  }
}

export function submit_uploads(
  device: GPUDevice,
  resources: WebGpuResources,
  uploads: readonly {
    readonly destination: string;
    readonly destination_offset: number;
    readonly bytes: Uint8Array;
  }[],
): number {
  let uploaded_bytes = 0;
  for (const upload of uploads) {
    const destination = resources.get(upload.destination);
    if (destination === undefined || !("mapAsync" in destination)) {
      throw new Error(
        `render upload destination ${
          JSON.stringify(upload.destination)
        } is not an installed GPU buffer`,
      );
    }
    try {
      device.queue.writeBuffer(
        destination as GPUBuffer,
        upload.destination_offset,
        upload.bytes,
      );
    } catch (error) {
      throw new Error(
        `render upload to ${
          JSON.stringify(upload.destination)
        } at offset ${upload.destination_offset} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    uploaded_bytes += upload.bytes.length;
  }
  return uploaded_bytes;
}

function destroy_native(resource: NativeRenderResource): void {
  if ("destroy" in resource && typeof resource.destroy === "function") {
    resource.destroy();
  }
}
